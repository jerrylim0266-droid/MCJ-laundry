<?php
declare(strict_types=1);

require_once __DIR__ . '/config.php';
washly_send_security_headers();
washly_start_session();

if (!washly_installed()) {
    header('Location: setup.php');
    exit;
}
if (washly_current_user() !== null) {
    header('Location: index.php');
    exit;
}

$error = '';
$notice = isset($_GET['setup']) ? 'Database berhasil disiapkan. Silakan masuk dengan akun admin Anda.' : '';
$csrfToken = washly_csrf_token();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $currentTime = time();
    $retryAfter = (int) ($_SESSION['login_retry_after'] ?? 0);

    if (!washly_verify_csrf((string) ($_POST['csrf_token'] ?? ''))) {
        $error = 'Sesi form kedaluwarsa. Muat ulang halaman dan coba lagi.';
    } elseif ($retryAfter > $currentTime) {
        $error = 'Terlalu banyak percobaan login. Coba kembali beberapa menit lagi.';
    } else {
        $username = trim((string) ($_POST['username'] ?? ''));
        $password = (string) ($_POST['password'] ?? '');
        try {
            $pdo = washly_database();
            $statement = $pdo->prepare('SELECT id, username, display_name, phone, password_hash FROM users WHERE username = :username LIMIT 1');
            $statement->execute(['username' => $username]);
            $user = $statement->fetch();

            if ($user === false || !password_verify($password, $user['password_hash'])) {
                $_SESSION['login_attempts'] = (int) ($_SESSION['login_attempts'] ?? 0) + 1;
                if ($_SESSION['login_attempts'] >= 5) {
                    $_SESSION['login_retry_after'] = $currentTime + 300;
                    $_SESSION['login_attempts'] = 0;
                }
                $error = 'Username atau kata sandi salah.';
            } else {
                session_regenerate_id(true);
                $_SESSION['user_id'] = (int) $user['id'];
                $_SESSION['username'] = (string) $user['username'];
                $_SESSION['display_name'] = (string) $user['display_name'];
                $_SESSION['phone'] = (string) $user['phone'];
                $_SESSION['login_attempts'] = 0;
                $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
                unset($_SESSION['login_retry_after']);
                header('Location: index.php');
                exit;
            }
        } catch (Throwable $exception) {
            error_log('Washly login failed: ' . $exception->getMessage());
            $error = 'Database belum dapat diakses. Pastikan MySQL menyala dan konfigurasi koneksi sudah benar.';
        }
    }
}
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="theme-color" content="#f5f7fb" />
  <title>Masuk Admin — Washly</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="styles.css" />
  <style>
    body{display:grid;min-height:100vh;place-items:center;padding:22px}.login-card{width:min(100%,410px);padding:32px;border:1px solid #eff0f5;border-radius:14px;background:#fff;box-shadow:0 12px 42px #20243610}.login-brand{margin-bottom:28px}.login-card h1{font-size:23px}.login-card>p{margin:8px 0 20px;color:#858b9e;font-size:11px}.login-error,.login-notice{margin:12px 0;padding:11px;border-radius:7px;font-size:10px;line-height:1.5}.login-error{background:#fff0f0;color:#bd4f55}.login-notice{background:#eef8f2;color:#358161}.login-submit{width:100%;margin-top:4px}.login-footer{margin-top:18px;color:#9a9faf;font-size:9px;line-height:1.6;text-align:center}
  </style>
</head>
<body>
  <main class="login-card">
    <a class="brand login-brand" href="login.php">
      <span class="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3C12.5 8.2 7 13.8 7 20a9 9 0 0 0 18 0c0-6.2-5.5-11.8-9-17Z" fill="currentColor"/><path d="M12 21c.5 2.1 2 3 4 3" fill="none" stroke="white" stroke-linecap="round" stroke-width="2"/></svg></span>
      <span class="brand-name">washly<span class="brand-dot">.</span><small>LAUNDRY MANAGEMENT</small></span>
    </a>
    <h1>Masuk sebagai admin</h1>
    <p>Login untuk mengelola data dan riwayat cucian.</p>
    <?php if ($notice !== ''): ?><div class="login-notice"><?= htmlspecialchars($notice, ENT_QUOTES, 'UTF-8') ?></div><?php endif; ?>
    <?php if ($error !== ''): ?><div class="login-error" role="alert"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></div><?php endif; ?>
    <form method="post" action="login.php">
      <input type="hidden" name="csrf_token" value="<?= htmlspecialchars($csrfToken, ENT_QUOTES, 'UTF-8') ?>" />
      <label class="form-field">Username<input name="username" required maxlength="32" autocomplete="username" autofocus /></label>
      <label class="form-field">Kata sandi<input name="password" type="password" required maxlength="72" autocomplete="current-password" /></label>
      <button class="button button-primary login-submit" type="submit">Masuk ke dashboard <span>→</span></button>
    </form>
    <p class="login-footer">Akun ini digunakan untuk mengakses seluruh data laundry.</p>
  </main>
</body>
</html>
