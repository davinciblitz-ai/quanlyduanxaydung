# Cùng phát triển

1. Tạo nhánh riêng từ main; `npm ci` và `npm test` trước khi sửa.
2. Giữ tiếng Việt, tên “Quản lý dự án xây dựng”, theme xanh–trắng và các quy ước thời gian ở README.
3. Không biến đường găng thành đường ngắn nhất: giữ đủ FS/SS/FF/SF và lag. Kéo bố cục sơ đồ không được thay đầu vào lịch.
4. Khi thay thuật toán, dùng bài nhỏ có nghiệm độc lập để đối chiếu. Không gắn nhãn tối ưu toàn cục cho kết quả dừng sớm.
5. Khi thay xe, kiểm tra bắt đầu từ chuẩn bị, chuyển tới/lùi qua đào–lấp–đầm–đổ bê tông, có đường vào/ra và không fade theo công tác.
6. Giữ phân quyền ở máy chủ. Không chỉ ẩn nút trên trình duyệt. Không commit dữ liệu, mật khẩu, token, SQLite hay báo cáo cá nhân.
7. Trước PR chạy `npm test`, `npm run test:browser` và ghi phạm vi đã kiểm tra, giới hạn còn lại. Thay schema SQLite cần migration tương thích dữ liệu cũ.
