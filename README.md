# Washly — sistem manajemen laundry

Panduan ini menjelaskan cara menjalankan Washly secara lokal menggunakan **XAMPP, PHP, dan MySQL**. Data pesanan, pelanggan, riwayat status, layanan, harga, dan akun administrator disimpan di database MySQL pada komputer Anda. Aplikasi PHP ini tidak menggunakan Google Sheets atau Google Apps Script.

## Persiapan

- Pasang dan buka XAMPP.
- Pastikan XAMPP menyediakan PHP dengan ekstensi `PDO MySQL` (`pdo_mysql`) dan `mbstring`.
- Salin folder proyek ke dalam folder `htdocs` XAMPP. Contoh lokasi: `C:\xampp\htdocs\washly`.
- Jika nama folder saat ini `MCJ laundry`, Anda dapat mengganti namanya menjadi `washly` agar alamat lokal lebih mudah diketik.

## Menyalakan aplikasi dengan XAMPP

1. Buka **XAMPP Control Panel**, lalu klik **Start** pada modul **Apache** dan **MySQL**. Pastikan keduanya berjalan.
2. Buka `http://localhost/washly/setup.php` di browser. Sesuaikan `washly` dengan nama folder proyek jika Anda tidak mengganti namanya.
3. Pada bagian koneksi database, gunakan pengaturan XAMPP lokal yang sesuai:
   - **Host:** `127.0.0.1`
   - **Port:** `3306` (ubah jika MySQL XAMPP Anda memakai port lain)
   - **Nama database:** `washly_laundry`
   - **Username MySQL:** `root`
   - **Password MySQL:** kosong pada instalasi XAMPP standar, kecuali Anda telah menetapkan password.
4. Buat username admin, nama lengkap, dan kata sandi unik minimal 12 karakter. Masukkan ulang kata sandi untuk konfirmasi.
5. Klik **Buat database & akun administrator**. Setup akan membuat database jika belum ada, menyiapkan tabel dari `schema.sql`, menambahkan layanan awal, membuat akun admin, dan menyimpan koneksi database ke `config.local.php`.
6. Setelah diarahkan ke halaman login, masuk dengan akun admin yang baru dibuat. Untuk penggunaan berikutnya, buka `http://localhost/washly/login.php` atau alamat folder proyek Anda.
7. Setelah masuk, gunakan **Buat Pesanan** untuk mencatat cucian. Data pesanan tersimpan di MySQL, dan daftar pelanggan dibuat dari pesanan yang tercatat.

Jangan membuka `index.php` dengan klik ganda dari File Explorer atau membuka berkas HTML secara langsung. Jalankan aplikasi melalui alamat `http://localhost/...` agar Apache memproses PHP.

## Database dan konfigurasi

- Anda tidak perlu mengimpor `schema.sql` secara manual saat instalasi baru; `setup.php` menjalankan skema tersebut.
- Setup harus dibuka dari komputer lokal (`localhost`) dan folder proyek harus dapat ditulisi PHP agar `config.local.php` dapat dibuat.
- Jika setup gagal, pastikan Apache dan MySQL menyala, port serta kredensial MySQL benar, ekstensi PHP `pdo_mysql` dan `mbstring` aktif, dan folder proyek dapat ditulisi.
- `config.local.php` berisi kredensial koneksi database. Jangan membagikan atau mengunggah berkas ini ke publik.
- Untuk memulai instalasi baru, jangan menghapus atau mengubah database lama sebelum membuat cadangan. Setup akan mengarahkan Anda ke login jika konfigurasi sudah dibuat.

## Keamanan dan pencadangan

- Kata sandi admin harus kuat dan berbeda dari kata sandi MySQL.
- Pengaturan XAMPP standar `root` tanpa password hanya untuk penggunaan lokal. Jangan gunakan konfigurasi tersebut untuk server yang dapat diakses dari internet.
- Nama dan nomor telepon pelanggan adalah data pribadi. Batasi akses komputer dan database yang menyimpan data tersebut.
- Untuk mencadangkan data lokal, buka `http://localhost/phpmyadmin`, pilih database `washly_laundry`, lalu gunakan menu **Export**. Simpan cadangan di lokasi aman.
- Untuk mengakses aplikasi dari internet, gunakan hosting yang mendukung PHP dan MySQL, HTTPS, serta akun database khusus dengan hak akses terbatas. Jangan mengekspos XAMPP lokal langsung ke internet.

## Memperbarui aplikasi

Simpan salinan cadangan database sebelum mengganti berkas aplikasi. Perubahan kode PHP, JavaScript, atau CSS lokal akan digunakan saat halaman dimuat ulang. Hindari mengganti `schema.sql` atau menghapus database setelah aplikasi mulai digunakan, karena tindakan tersebut dapat menghilangkan data atau membuat struktur tabel tidak sesuai.

## Batasan

- Aplikasi ini menyediakan satu akun administrator.
- Menu **Stok & Inventori** masih menampilkan contoh dan belum disimpan ke database.
- Aplikasi saat ini belum mengunggah gambar atau mengubah gambar menjadi data secara otomatis; data pesanan perlu dimasukkan melalui formulir.
- Berkas `Code.gs`, `Index.html`, `Styles.html`, dan `App.html` adalah bagian dari versi Google Apps Script. Untuk menjalankan versi XAMPP, gunakan berkas PHP, `app.js`, dan `styles.css`.
