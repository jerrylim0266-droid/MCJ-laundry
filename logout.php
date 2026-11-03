<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
washly_send_security_headers();
washly_start_session();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: login.php');
    exit;
}

if (washly_current_user() === null || !washly_verify_csrf((string) ($_POST['csrf_token'] ?? ''))) {
    http_response_code(400);
    echo 'Permintaan tidak valid. Muat ulang aplikasi dan coba lagi.';
    exit;
}

$_SESSION = [];
$cookie = session_get_cookie_params();
setcookie(session_name(), '', [
    'expires' => time() - 3600,
    'path' => $cookie['path'],
    'domain' => $cookie['domain'],
    'secure' => $cookie['secure'],
    'httponly' => $cookie['httponly'],
    'samesite' => 'Lax',
]);
session_destroy();
header('Location: login.php');
exit;
