<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
washly_send_security_headers();
header('Content-Type: application/json; charset=utf-8');
washly_start_session();

final class WashlyApiException extends RuntimeException
{
    public function __construct(string $message, public readonly int $status = 400)
    {
        parent::__construct($message);
    }
}

function api_reply(array $body, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function api_input(): array
{
    $length = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($length > 1048576) {
        throw new WashlyApiException('Ukuran permintaan terlalu besar.', 413);
    }
    $decoded = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($decoded)) {
        throw new WashlyApiException('Format permintaan tidak valid.', 400);
    }

    return $decoded;
}

function api_required_string(array $input, string $field, int $maximum, string $label): string
{
    $value = $input[$field] ?? null;
    if (!is_string($value)) {
        throw new WashlyApiException($label . ' harus berupa teks.');
    }
    $value = trim($value);
    if ($value === '' || mb_strlen($value) > $maximum) {
        throw new WashlyApiException(sprintf('%s wajib diisi (maksimal %d karakter).', $label, $maximum));
    }

    return $value;
}

function api_mysql_datetime(string $value, string $label): string
{
    try {
        $date = new DateTimeImmutable($value, new DateTimeZone('Asia/Jakarta'));
    } catch (Throwable) {
        throw new WashlyApiException($label . ' tidak valid.');
    }

    return $date->setTimezone(new DateTimeZone('Asia/Jakarta'))->format('Y-m-d H:i:s');
}

function api_iso_datetime(string $value): string
{
    return (new DateTimeImmutable($value, new DateTimeZone('Asia/Jakarta')))->format(DATE_ATOM);
}

function api_bootstrap(PDO $pdo, array $user): never
{
    $orderRows = $pdo->query(
        'SELECT id, order_code, customer_name, customer_phone, weight_kg, service_name, price_per_kg,
                total_amount, received_at, status, created_at
         FROM laundry_orders ORDER BY received_at DESC, id DESC'
    )->fetchAll();
    $historyRows = $pdo->query(
        'SELECT h.order_id, h.status, h.changed_at
         FROM laundry_order_status_history h
         ORDER BY h.changed_at ASC, h.id ASC'
    )->fetchAll();

    $historyByOrder = [];
    foreach ($historyRows as $history) {
        $historyByOrder[(int) $history['order_id']][] = [
            'status' => $history['status'],
            'changedAt' => api_iso_datetime($history['changed_at']),
        ];
    }

    $orders = [];
    foreach ($orderRows as $row) {
        $name = $row['customer_name'];
        $orders[] = [
            'id' => $row['order_code'],
            'name' => $name,
            'phone' => $row['customer_phone'],
            'service' => $row['service_name'],
            'weight' => (float) $row['weight_kg'],
            'pricePerKg' => (float) $row['price_per_kg'],
            'amount' => (float) $row['total_amount'],
            'status' => $row['status'],
            'receivedAt' => api_iso_datetime($row['received_at']),
            'createdAt' => api_iso_datetime($row['created_at']),
            'initials' => mb_strtoupper(implode('', array_map(
                static fn (string $part): string => mb_substr($part, 0, 1),
                array_slice(preg_split('/\s+/', $name) ?: [], 0, 2)
            ))),
            'avatar' => 'av-purple',
            'statusHistory' => $historyByOrder[(int) $row['id']] ?? [],
        ];
    }

    $serviceRows = $pdo->query(
        'SELECT name, price_per_kg, turnaround
         FROM laundry_services ORDER BY id ASC'
    )->fetchAll();
    $services = array_map(static fn (array $row): array => [
        'name' => $row['name'],
        'price' => (float) $row['price_per_kg'],
        'turnaround' => $row['turnaround'],
    ], $serviceRows);

    api_reply([
        'csrfToken' => washly_csrf_token(),
        'profile' => $user,
        'orders' => $orders,
        'services' => $services,
    ]);
}

function api_save_order(PDO $pdo, array $input, array $user): never
{
    $existingCode = $input['id'] ?? '';
    if (!is_string($existingCode)) {
        throw new WashlyApiException('Kode cucian tidak valid.');
    }
    $existingCode = trim($existingCode);
    $name = api_required_string($input, 'name', 80, 'Nama pelanggan');
    $phone = api_required_string($input, 'phone', 24, 'Nomor telepon');
    $service = api_required_string($input, 'service', 60, 'Layanan');
    $weight = filter_var($input['weight'] ?? null, FILTER_VALIDATE_FLOAT);
    $pricePerKg = filter_var($input['pricePerKg'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($weight === false || $weight <= 0 || $weight > 10000) {
        throw new WashlyApiException('Berat cucian harus lebih dari 0 kg dan maksimal 10.000 kg.');
    }
    if ($pricePerKg === false || $pricePerKg <= 0 || $pricePerKg > 100000000) {
        throw new WashlyApiException('Harga layanan per kg tidak valid.');
    }
    $status = $input['status'] ?? null;
    if (!in_array($status, ['Diterima', 'Dicuci', 'Dikeringkan', 'Siap diambil', 'Selesai', 'Dibatalkan'], true)) {
        throw new WashlyApiException('Status cucian tidak valid.');
    }
    $rawReceivedAt = $input['receivedAt'] ?? null;
    if (!is_string($rawReceivedAt)) {
        throw new WashlyApiException('Tanggal masuk tidak valid.');
    }
    $receivedAt = api_mysql_datetime($rawReceivedAt, 'Tanggal masuk');

    $pdo->beginTransaction();
    try {
        if ($existingCode !== '') {
            $findOrder = $pdo->prepare('SELECT id, status, service_name FROM laundry_orders WHERE order_code = :code FOR UPDATE');
            $findOrder->execute(['code' => $existingCode]);
            $existing = $findOrder->fetch();
            if ($existing === false) {
                throw new WashlyApiException('Data cucian tidak ditemukan.', 404);
            }
            if ($service !== $existing['service_name']) {
                $findService = $pdo->prepare('SELECT 1 FROM laundry_services WHERE name = :name');
                $findService->execute(['name' => $service]);
                if ($findService->fetchColumn() === false) {
                    throw new WashlyApiException('Pilih layanan yang tersedia di daftar harga.');
                }
            }
            $update = $pdo->prepare(
                'UPDATE laundry_orders
                 SET customer_name = :name, customer_phone = :phone, weight_kg = :weight,
                     service_name = :service, price_per_kg = :price, total_amount = :amount,
                     received_at = :received, status = :status
                 WHERE id = :id'
            );
            $update->execute([
                'name' => $name,
                'phone' => $phone,
                'weight' => $weight,
                'service' => $service,
                'price' => $pricePerKg,
                'amount' => round($weight * $pricePerKg),
                'received' => $receivedAt,
                'status' => $status,
                'id' => $existing['id'],
            ]);
            if ($existing['status'] !== $status) {
                $history = $pdo->prepare(
                    'INSERT INTO laundry_order_status_history (order_id, status, changed_by)
                     VALUES (:order_id, :status, :user_id)'
                );
                $history->execute(['order_id' => $existing['id'], 'status' => $status, 'user_id' => $user['id']]);
            }
            $code = $existingCode;
        } else {
            $findService = $pdo->prepare('SELECT 1 FROM laundry_services WHERE name = :name');
            $findService->execute(['name' => $service]);
            if ($findService->fetchColumn() === false) {
                throw new WashlyApiException('Pilih layanan yang tersedia di daftar harga.');
            }
            $insert = $pdo->prepare(
                'INSERT INTO laundry_orders
                    (order_code, customer_name, customer_phone, weight_kg, service_name, price_per_kg, total_amount,
                     received_at, status, created_by)
                 VALUES (:code, :name, :phone, :weight, :service, :price, :amount, :received, :status, :user_id)'
            );
            $insert->execute([
                'code' => 'PENDING-' . bin2hex(random_bytes(12)),
                'name' => $name,
                'phone' => $phone,
                'weight' => $weight,
                'service' => $service,
                'price' => $pricePerKg,
                'amount' => round($weight * $pricePerKg),
                'received' => $receivedAt,
                'status' => $status,
                'user_id' => $user['id'],
            ]);
            $orderId = (int) $pdo->lastInsertId();
            $code = sprintf('WSH-%s-%06d', (new DateTimeImmutable('now', new DateTimeZone('Asia/Jakarta')))->format('Y'), $orderId);
            $setCode = $pdo->prepare('UPDATE laundry_orders SET order_code = :code WHERE id = :id');
            $setCode->execute(['code' => $code, 'id' => $orderId]);
            $history = $pdo->prepare(
                'INSERT INTO laundry_order_status_history (order_id, status, changed_by)
                 VALUES (:order_id, :status, :user_id)'
            );
            $history->execute(['order_id' => $orderId, 'status' => $status, 'user_id' => $user['id']]);
        }
        $pdo->commit();
        api_reply(['success' => true, 'id' => $code]);
    } catch (Throwable $exception) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $exception;
    }
}

function api_change_status(PDO $pdo, array $input, array $user): never
{
    $code = is_string($input['id'] ?? null) ? trim($input['id']) : '';
    $status = is_string($input['status'] ?? null) ? $input['status'] : '';
    if ($code === '' || !in_array($status, ['Diterima', 'Dicuci', 'Dikeringkan', 'Siap diambil', 'Selesai', 'Dibatalkan'], true)) {
        throw new WashlyApiException('Pesanan atau status cucian tidak valid.');
    }

    $pdo->beginTransaction();
    try {
        $find = $pdo->prepare('SELECT id, status FROM laundry_orders WHERE order_code = :code FOR UPDATE');
        $find->execute(['code' => $code]);
        $order = $find->fetch();
        if ($order === false) {
            throw new WashlyApiException('Data cucian tidak ditemukan.', 404);
        }
        if ($order['status'] !== $status) {
            $update = $pdo->prepare('UPDATE laundry_orders SET status = :status WHERE id = :id');
            $update->execute(['status' => $status, 'id' => $order['id']]);
            $history = $pdo->prepare(
                'INSERT INTO laundry_order_status_history (order_id, status, changed_by)
                 VALUES (:order_id, :status, :user_id)'
            );
            $history->execute(['order_id' => $order['id'], 'status' => $status, 'user_id' => $user['id']]);
        }
        $pdo->commit();
        api_reply(['success' => true]);
    } catch (Throwable $exception) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $exception;
    }
}

function api_save_service(PDO $pdo, array $input): never
{
    $originalName = trim((string) ($input['originalName'] ?? ''));
    $name = api_required_string($input, 'name', 60, 'Nama layanan');
    $turnaround = api_required_string($input, 'turnaround', 40, 'Estimasi selesai');
    $price = filter_var($input['price'] ?? null, FILTER_VALIDATE_FLOAT);
    if ($price === false || $price <= 0 || $price > 100000000) {
        throw new WashlyApiException('Harga layanan harus lebih dari Rp 0.');
    }

    $duplicate = $pdo->prepare('SELECT 1 FROM laundry_services WHERE name = :name AND name <> :original');
    $duplicate->execute(['name' => $name, 'original' => $originalName]);
    if ($duplicate->fetchColumn() !== false) {
        throw new WashlyApiException('Nama layanan tersebut sudah digunakan.');
    }

    if ($originalName !== '') {
        $existing = $pdo->prepare('SELECT 1 FROM laundry_services WHERE name = :original');
        $existing->execute(['original' => $originalName]);
        if ($existing->fetchColumn() === false) {
            throw new WashlyApiException('Layanan yang akan diubah tidak ditemukan.', 404);
        }
        $update = $pdo->prepare(
            'UPDATE laundry_services SET name = :name, price_per_kg = :price, turnaround = :turnaround
             WHERE name = :original'
        );
        $update->execute(['name' => $name, 'price' => $price, 'turnaround' => $turnaround, 'original' => $originalName]);
        if ($update->rowCount() === 0 && $name !== $originalName) {
            $exists = $pdo->prepare('SELECT 1 FROM laundry_services WHERE name = :name');
            $exists->execute(['name' => $name]);
            if ($exists->fetchColumn() === false) {
                throw new WashlyApiException('Layanan yang akan diubah tidak ditemukan.', 404);
            }
        }
    } else {
        $insert = $pdo->prepare(
            'INSERT INTO laundry_services (name, price_per_kg, turnaround)
             VALUES (:name, :price, :turnaround)'
        );
        $insert->execute(['name' => $name, 'price' => $price, 'turnaround' => $turnaround]);
    }

    api_reply(['success' => true]);
}

try {
    if (!washly_installed()) {
        api_reply(['error' => 'Pengaturan awal database belum selesai.'], 503);
    }

    $user = washly_current_user();
    if ($user === null) {
        api_reply(['error' => 'Sesi login berakhir. Silakan masuk kembali.'], 401);
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        $csrf = (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? '');
        if (!washly_verify_csrf($csrf)) {
            api_reply(['error' => 'Token keamanan tidak valid. Muat ulang halaman dan coba kembali.'], 403);
        }
    }

    $pdo = washly_database();
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && ($_GET['action'] ?? '') === 'bootstrap') {
        api_bootstrap($pdo, $user);
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        api_reply(['error' => 'Metode permintaan tidak didukung.'], 405);
    }

    $input = api_input();
    $action = (string) ($input['action'] ?? '');
    if ($action === 'save_order') {
        api_save_order($pdo, is_array($input['order'] ?? null) ? $input['order'] : [], $user);
    }
    if ($action === 'change_status') {
        api_change_status($pdo, $input, $user);
    }
    if ($action === 'delete_order') {
        $code = trim((string) ($input['id'] ?? ''));
        if ($code === '') {
            throw new WashlyApiException('Kode cucian wajib diisi.');
        }
        $delete = $pdo->prepare('DELETE FROM laundry_orders WHERE order_code = :code');
        $delete->execute(['code' => $code]);
        if ($delete->rowCount() === 0) {
            throw new WashlyApiException('Data cucian tidak ditemukan.', 404);
        }
        api_reply(['success' => true]);
    }
    if ($action === 'save_service') {
        api_save_service($pdo, $input);
    }
    if ($action === 'delete_service') {
        $name = api_required_string($input, 'name', 60, 'Nama layanan');
        $usage = $pdo->prepare('SELECT 1 FROM laundry_orders WHERE service_name = :name LIMIT 1');
        $usage->execute(['name' => $name]);
        if ($usage->fetchColumn() !== false) {
            throw new WashlyApiException('Layanan ini masih tercatat pada riwayat cucian dan tidak dapat dihapus.');
        }
        if ((int) $pdo->query('SELECT COUNT(*) FROM laundry_services')->fetchColumn() <= 1) {
            throw new WashlyApiException('Minimal harus tersedia satu layanan.');
        }
        $delete = $pdo->prepare('DELETE FROM laundry_services WHERE name = :name');
        $delete->execute(['name' => $name]);
        if ($delete->rowCount() === 0) {
            throw new WashlyApiException('Layanan tidak ditemukan.', 404);
        }
        api_reply(['success' => true]);
    }
    if ($action === 'save_account') {
        $username = api_required_string($input, 'username', 32, 'Username');
        if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
            throw new WashlyApiException('Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
        }
        $name = api_required_string($input, 'name', 60, 'Nama administrator');
        $phone = $input['phone'] ?? '';
        if (!is_string($phone)) {
            throw new WashlyApiException('Nomor telepon harus berupa teks.');
        }
        $phone = trim($phone);
        if (mb_strlen($phone) > 24) {
            throw new WashlyApiException('Nomor telepon maksimal 24 karakter.');
        }
        $currentPassword = $input['currentPassword'] ?? null;
        $newPassword = $input['newPassword'] ?? '';
        if (!is_string($currentPassword) || !is_string($newPassword)) {
            throw new WashlyApiException('Kata sandi tidak valid.');
        }
        $findAdmin = $pdo->prepare('SELECT password_hash FROM users WHERE id = :id');
        $findAdmin->execute(['id' => $user['id']]);
        $adminRecord = $findAdmin->fetch();
        if ($adminRecord === false || !password_verify($currentPassword, $adminRecord['password_hash'])) {
            throw new WashlyApiException('Kata sandi saat ini salah.', 403);
        }
        if ($newPassword !== '' && strlen($newPassword) < 12) {
            throw new WashlyApiException('Kata sandi baru harus minimal 12 karakter.');
        }
        if ($newPassword !== '' && strlen($newPassword) > 72) {
            throw new WashlyApiException('Kata sandi baru maksimal 72 karakter.');
        }
        $usernameExists = $pdo->prepare('SELECT 1 FROM users WHERE username = :username AND id <> :id');
        $usernameExists->execute(['username' => $username, 'id' => $user['id']]);
        if ($usernameExists->fetchColumn() !== false) {
            throw new WashlyApiException('Username tersebut sudah digunakan.', 409);
        }
        $updateAdmin = $pdo->prepare(
            $newPassword === ''
                ? 'UPDATE users SET username = :username, display_name = :name, phone = :phone WHERE id = :id'
                : 'UPDATE users SET username = :username, display_name = :name, phone = :phone, password_hash = :password WHERE id = :id'
        );
        $params = ['username' => $username, 'name' => $name, 'phone' => $phone, 'id' => $user['id']];
        if ($newPassword !== '') {
            $params['password'] = password_hash($newPassword, PASSWORD_DEFAULT);
        }
        $updateAdmin->execute($params);
        $_SESSION['username'] = $username;
        $_SESSION['display_name'] = $name;
        $_SESSION['phone'] = $phone;
        session_regenerate_id(true);
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
        api_reply(['success' => true, 'csrfToken' => washly_csrf_token(), 'profile' => washly_current_user()]);
    }

    api_reply(['error' => 'Aksi yang diminta tidak tersedia.'], 404);
} catch (WashlyApiException $exception) {
    api_reply(['error' => $exception->getMessage()], $exception->status);
} catch (PDOException $exception) {
    error_log('Washly API database error: ' . $exception->getMessage());
    api_reply(['error' => 'Database gagal memproses perubahan. Periksa koneksi MySQL dan data yang dikirim.'], 500);
} catch (Throwable $exception) {
    error_log('Washly API error: ' . $exception->getMessage());
    api_reply(['error' => 'Terjadi kesalahan saat memproses permintaan. Coba kembali dan periksa log server bila masalah berlanjut.'], 500);
}
