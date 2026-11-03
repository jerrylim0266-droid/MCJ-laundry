<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
washly_send_security_headers();
washly_start_session();

if (washly_installed()) {
    header('Location: login.php');
    exit;
}

$remoteAddress = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
if (!in_array($remoteAddress, ['127.0.0.1', '::1'], true)) {
    http_response_code(404);
    echo 'Pengaturan awal hanya tersedia secara lokal. Hubungi administrator server.';
    exit;
}

if (empty($_SESSION['setup_csrf'])) {
    $_SESSION['setup_csrf'] = bin2hex(random_bytes(32));
}

$error = '';
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    try {
        if (!hash_equals((string) $_SESSION['setup_csrf'], (string) ($_POST['csrf_token'] ?? ''))) {
            throw new RuntimeException('Form kedaluwarsa. Muat ulang halaman sebelum mencoba lagi.');
        }

        $host = trim((string) ($_POST['db_host'] ?? ''));
        $port = filter_var($_POST['db_port'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
        $database = trim((string) ($_POST['db_name'] ?? ''));
        $dbUsername = trim((string) ($_POST['db_user'] ?? ''));
        $dbPassword = (string) ($_POST['db_password'] ?? '');
        $username = trim((string) ($_POST['admin_username'] ?? ''));
        $displayName = trim((string) ($_POST['admin_name'] ?? ''));
        $adminPassword = (string) ($_POST['admin_password'] ?? '');

        if ($host === '' || strlen($host) > 255 || preg_match('/[\r\n;]/', $host)) {
            throw new RuntimeException('Nama host database tidak valid.');
        }
        if ($port === false || !preg_match('/^[A-Za-z0-9_]{1,64}$/', $database)) {
            throw new RuntimeException('Port atau nama database tidak valid.');
        }
        if ($dbUsername === '' || strlen($dbUsername) > 128) {
            throw new RuntimeException('Nama pengguna database wajib diisi.');
        }
        if (!preg_match('/^[A-Za-z0-9._-]{3,32}$/', $username)) {
            throw new RuntimeException('Username administrator harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
        }
        if ($displayName === '' || mb_strlen($displayName) > 60) {
            throw new RuntimeException('Nama administrator wajib diisi dan maksimal 60 karakter.');
        }
        if (strlen($adminPassword) < 12 || strlen($adminPassword) > 72) {
            throw new RuntimeException('Kata sandi administrator harus terdiri dari 12–72 byte.');
        }
        if (!hash_equals($adminPassword, (string) ($_POST['admin_password_confirmation'] ?? ''))) {
            throw new RuntimeException('Konfirmasi kata sandi administrator belum cocok.');
        }
        if (!is_file(__DIR__ . '/schema.sql') || !is_readable(__DIR__ . '/schema.sql')) {
            throw new RuntimeException('Berkas schema.sql tidak ditemukan.');
        }
        if (!is_writable(__DIR__)) {
            throw new RuntimeException('Folder aplikasi harus dapat ditulisi PHP untuk menyimpan config.local.php.');
        }

        $server = new PDO(
            sprintf('mysql:host=%s;port=%d;charset=utf8mb4', $host, $port),
            $dbUsername,
            $dbPassword,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
        $checkDatabase = $server->prepare('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = :database');
        $checkDatabase->execute(['database' => $database]);
        if ($checkDatabase->fetchColumn() === false) {
            $server->exec(sprintf(
                'CREATE DATABASE `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
                $database
            ));
        }

        $settings = [
            'host' => $host,
            'port' => $port,
            'database' => $database,
            'username' => $dbUsername,
            'password' => $dbPassword,
        ];
        $pdo = washly_database($settings);
        $schema = file_get_contents(__DIR__ . '/schema.sql');
        foreach (explode(';', (string) $schema) as $statement) {
            if (trim($statement) !== '') {
                $pdo->exec($statement);
            }
        }

        $checkAdmin = $pdo->query('SELECT id FROM users LIMIT 1');
        if ($checkAdmin->fetch() !== false) {
            throw new RuntimeException('Database ini sudah memiliki akun administrator. Gunakan menu login, bukan pengaturan awal.');
        }

        $configuration = "<?php\nreturn " . var_export($settings, true) . ";\n";
        $configPath = WASHLY_CONFIG_PATH;
        $temporaryConfig = __DIR__ . '/config.local.tmp.php';
        $configInstalled = false;
        $pdo->beginTransaction();
        try {
            $createAdmin = $pdo->prepare(
                'INSERT INTO users (username, display_name, password_hash) VALUES (:username, :name, :password)'
            );
            $createAdmin->execute([
                'username' => $username,
                'name' => $displayName,
                'password' => password_hash($adminPassword, PASSWORD_DEFAULT),
            ]);

            if ((int) $pdo->query('SELECT COUNT(*) FROM laundry_services')->fetchColumn() === 0) {
                $createService = $pdo->prepare(
                    'INSERT INTO laundry_services (name, price_per_kg, turnaround) VALUES (:name, :price, :turnaround)'
                );
                foreach ([
                    ['Cuci Komplit', 7000, '2–3 hari'],
                    ['Cuci & Setrika', 10000, '2–3 hari'],
                    ['Setrika Saja', 6000, '1–2 hari'],
                    ['Express 6 Jam', 15000, '6 jam'],
                ] as [$serviceName, $price, $turnaround]) {
                    $createService->execute(['name' => $serviceName, 'price' => $price, 'turnaround' => $turnaround]);
                }
            }
            if (file_put_contents($temporaryConfig, $configuration, LOCK_EX) === false
                || !rename($temporaryConfig, $configPath)) {
                throw new RuntimeException('Pengaturan database gagal disimpan. Pastikan folder aplikasi dapat ditulisi PHP.');
            }
            $configInstalled = true;
            @chmod($configPath, 0600);
            $pdo->commit();
        } catch (Throwable $exception) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            if (is_file($temporaryConfig)) {
                unlink($temporaryConfig);
            }
            if ($configInstalled && is_file($configPath)) {
                unlink($configPath);
            }
            throw $exception;
        }

        session_regenerate_id(true);
        unset($_SESSION['setup_csrf']);
        header('Location: login.php?setup=done');
        exit;
    } catch (PDOException $exception) {
        error_log('Washly database setup failed: ' . $exception->getMessage());
        $error = 'Database tidak dapat diakses atau disiapkan. Pastikan MySQL XAMPP menyala dan periksa host, port, username, dan password database.';
    } catch (Throwable $exception) {
        error_log('Washly setup failed: ' . $exception->getMessage());
        $error = $exception instanceof RuntimeException
            ? $exception->getMessage()
            : 'Pengaturan gagal. Periksa konfigurasi database dan izin folder, lalu coba kembali.';
    }
}
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#f5f7fb" />
  <title>Pengaturan awal Washly</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
  <style>
    body{display:grid;min-height:100vh;place-items:center;padding:24px}.setup-card{width:min(100%,600px);padding:30px;border:1px solid #eff0f5;border-radius:14px;background:#fff;box-shadow:0 12px 42px #20243610}.setup-card h1{font-size:24px}.setup-card>p:not(.eyebrow){color:#858b9e;font-size:12px;line-height:1.7}.setup-section{margin-top:22px;padding-top:18px;border-top:1px solid #eff0f5}.setup-section h2{margin-bottom:14px;font-size:13px}.setup-grid{display:grid;grid-template-columns:1fr 1fr;gap:0 13px}.setup-notice{margin:16px 0;padding:12px;border-radius:7px;background:#fff7e9;color:#89652c;font-size:10px;line-height:1.7}.setup-error{margin:12px 0;padding:12px;border-radius:7px;background:#fff0f0;color:#bd4f55;font-size:11px}.setup-submit{width:100%;margin-top:8px}.password-hint{margin-top:-8px;color:#979cad;font-size:9px}@media(max-width:520px){.setup-card{padding:22px 17px}.setup-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="setup-card">
    <p class="eyebrow">PERSIAPAN APLIKASI</p>
    <h1>Siapkan database & akun admin</h1>
    <p>Masukkan kredensial MySQL XAMPP dan buat username serta kata sandi admin Anda. Daftar harga layanan awal akan ditambahkan secara otomatis.</p>
    <?php if ($error !== ''): ?>
      <div class="setup-error" role="alert"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></div>
    <?php endif; ?>
    <form method="post" action="setup.php" autocomplete="off">
      <input type="hidden" name="csrf_token" value="<?= htmlspecialchars((string) $_SESSION['setup_csrf'], ENT_QUOTES, 'UTF-8') ?>" />
      <section class="setup-section">
        <h2>Koneksi database XAMPP</h2>
        <div class="setup-grid">
          <label class="form-field">Host MySQL<input name="db_host" required maxlength="255" value="<?= htmlspecialchars((string) ($_POST['db_host'] ?? '127.0.0.1'), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Port<input name="db_port" required type="number" min="1" max="65535" value="<?= htmlspecialchars((string) ($_POST['db_port'] ?? '3306'), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Nama database<input name="db_name" required maxlength="64" pattern="[A-Za-z0-9_]{1,64}" value="<?= htmlspecialchars((string) ($_POST['db_name'] ?? 'washly_laundry'), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Username MySQL<input name="db_user" required maxlength="128" value="<?= htmlspecialchars((string) ($_POST['db_user'] ?? 'root'), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Password MySQL<input name="db_password" type="password" autocomplete="new-password" /></label>
        </div>
      </section>
      <section class="setup-section">
        <h2>Akun administrator</h2>
        <div class="setup-grid">
          <label class="form-field">Username admin<input name="admin_username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9._-]{3,32}" autocomplete="username" value="<?= htmlspecialchars((string) ($_POST['admin_username'] ?? ''), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Nama lengkap<input name="admin_name" required maxlength="60" autocomplete="name" value="<?= htmlspecialchars((string) ($_POST['admin_name'] ?? ''), ENT_QUOTES, 'UTF-8') ?>" /></label>
          <label class="form-field">Kata sandi<input name="admin_password" type="password" required minlength="12" maxlength="72" autocomplete="new-password" /></label>
          <label class="form-field">Ulangi kata sandi<input name="admin_password_confirmation" type="password" required minlength="12" maxlength="72" autocomplete="new-password" /></label>
        </div>
        <p class="password-hint">Gunakan kata sandi yang kuat dan berbeda dari password MySQL; minimal 12 karakter.</p>
      </section>
      <div class="setup-notice"><strong>Penting untuk website publik:</strong> jangan gunakan user MySQL root atau password kosong di server internet. Buat database dan user MySQL khusus dengan hak akses hanya ke database Washly sebelum memasang aplikasi publik. Selalu gunakan hosting HTTPS.</div>
      <button class="button button-primary setup-submit" type="submit">Buat database & akun administrator</button>
    </form>
  </main>
  <script>
    document.querySelector("form").addEventListener("submit", (event) => {
      const fields = event.currentTarget.elements;
      if (fields.admin_password.value !== fields.admin_password_confirmation.value) {
        event.preventDefault();
        window.alert("Konfirmasi kata sandi admin belum cocok.");
      }
    });
  </script>
</body>
</html>
