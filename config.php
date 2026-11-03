<?php
declare(strict_types=1);

const WASHLY_CONFIG_PATH = __DIR__ . '/config.local.php';

date_default_timezone_set('Asia/Jakarta');

function washly_send_security_headers(): void
{
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
    header('Cache-Control: no-store, private');
}

function washly_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    session_name('washly_session');
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_start();
}

function washly_installed(): bool
{
    return is_file(WASHLY_CONFIG_PATH);
}

function washly_database(array $settings = []): PDO
{
    if ($settings === []) {
        if (!washly_installed()) {
            throw new RuntimeException('Selesaikan pengaturan awal database sebelum membuka aplikasi.');
        }

        $settings = require WASHLY_CONFIG_PATH;
    }

    if (!is_array($settings)
        || !isset($settings['host'], $settings['port'], $settings['database'], $settings['username'], $settings['password'])) {
        throw new RuntimeException('Pengaturan koneksi database tidak lengkap. Buka setup.php untuk mengaturnya kembali.');
    }

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
        $settings['host'],
        (int) $settings['port'],
        $settings['database']
    );

    $pdo = new PDO($dsn, $settings['username'], $settings['password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::MYSQL_ATTR_INIT_COMMAND => "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
    ]);
    $pdo->exec("SET time_zone = '+07:00'");

    return $pdo;
}

function washly_current_user(): ?array
{
    return isset($_SESSION['user_id'], $_SESSION['username'], $_SESSION['display_name'])
        ? [
            'id' => (int) $_SESSION['user_id'],
            'username' => (string) $_SESSION['username'],
            'name' => (string) $_SESSION['display_name'],
            'phone' => (string) ($_SESSION['phone'] ?? ''),
        ]
        : null;
}

function washly_require_user(): array
{
    $user = washly_current_user();
    if ($user === null) {
        header('Location: login.php');
        exit;
    }

    return $user;
}

function washly_csrf_token(): string
{
    if (!isset($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }

    return (string) $_SESSION['csrf_token'];
}

function washly_verify_csrf(string $submitted): bool
{
    return isset($_SESSION['csrf_token']) && hash_equals((string) $_SESSION['csrf_token'], $submitted);
}
