# Kết quả kiểm thử bản chạy thử

Ngày thực hiện: 18/10/2026. Môi trường: Windows, Node.js 24.21.0, Microsoft Edge headless qua Playwright. Các kiểm tra cảm ứng và giảm CPU là mô phỏng trên máy tính.

## Phép tính và máy chủ

`npm test` đạt 16 nhóm kiểm thử phép tính cùng nhóm kiểm thử máy chủ.

| Nội dung | Kết quả |
|---|---|
| Bài mẫu A–G của Word | 25 ngày; A–D–F–G găng; trực tiếp 450 USD |
| Tìm đủ 360 tổ hợp rút ngắn | 22 ngày, trực tiếp 525 + gián tiếp 250 = tổng 775 USD; phương án 21 ngày có trực tiếp 610 USD |
| FS/SS/FF/SF, lag âm/dương, nhiều tiền nhiệm | Đạt các trường hợp có giá trị kỳ vọng cụ thể; SF có tác động thực sự khi tiền nhiệm bắt đầu sau mốc 0 |
| 200 mạng công việc nhỏ | Đối chiếu LS với mọi lịch nguyên khả thi trong thời hạn; kiểm tra ES/LS, dự trữ và ràng buộc |
| Mạng nhiều nhánh găng, công việc độc lập, mốc 0 ngày | Đạt |
| Mã trùng/thiếu, vòng lặp, tự phụ thuộc, thời lượng âm hoặc không nguyên | Bị từ chối |
| BOQ, chi phí chung, khác, dự phòng và thuế | Đúng theo công thức mô hình nội bộ |
| Lãi vay 0, lãi rất nhỏ, trả gốc đều và trả tổng đều | Tổng gốc khớp, lãi tính trên dư nợ đầu tháng, dư nợ cuối bằng 0 |
| NPV/IRR | Kiểm chứng nghiệm 10%; dòng tiền đổi dấu nhiều lần không trả một IRR duy nhất |
| EVM và mẫu số 0 | PV/EV/AC/CPI/SPI/EAC khớp; trường hợp thiếu dữ liệu hiển thị chưa xác định |
| Lịch 5/6/7 ngày, ngày nghỉ, năm nhuận | Đạt; ngày không tồn tại bị từ chối |
| Đăng nhập, session, quyền theo dự án | Người ngoài không đọc dự án; viewer không sửa; editor sửa được; owner cấp quyền được |
| Sửa cùng phiên bản | Máy chủ trả xung đột 409, tránh ghi đè âm thầm |
| Nguồn yêu cầu khác và tệp nội bộ | Chặn Origin khác; không phục vụ dữ liệu SQLite hoặc cấu hình `.codex` |
| Nhật ký và đăng xuất | Có sự kiện; cookie phiên đã đăng xuất không dùng lại được |

## Luồng sử dụng qua trình duyệt

Đã thao tác trên giao diện để tạo/sửa công việc, gây và sửa lỗi vòng, chốt kế hoạch gốc, thêm BOQ, đồng bộ ngân sách, tính vay 0%, nhập dòng tiền IRR, thêm rủi ro, chạy thanh thời gian 3D, tìm/áp dụng phương án 22 ngày và xuất/nhập lại JSON.

Đã tạo quản trị, tạo thành viên, cấp quyền viewer, đăng nhập bằng phiên trình duyệt thứ hai và xác nhận giao diện báo quyền chỉ xem khi cố lưu thay đổi. Không dùng tài khoản hay mật khẩu kiểm thử làm mặc định cho ứng dụng.

## Hiển thị và tương tác bản WebGL

- 320, 375, 414, 768, 1440 px: trang đầu, hai chế độ và các màn hình công cụ không tràn ngang; bảng lớn có vùng cuộn riêng.
- Trang đầu chỉ có một Canvas 3D. Vào công cụ rồi quay về ba lần: luôn có một cảnh và một vùng vẽ, WebGL context không mất, có draw calls. Rời trang 3D giải phóng cảnh.
- Logo được tải đúng, màu chính #032b91 và nền trắng. Bốn góc xem thép móng, thép chờ, cột–dầm–sàn và mạch ngừng đều có cấu kiện cần xem; xem chi tiết không thay đổi thời lượng CPM.
- Đào đất: có hố sâu, xe đào và xe ben; không có xe lu. Bê tông móng: chưa lấp đất. Rải lớp: có xe ben, móng đã đổ, xe lu chưa hoạt động. Đầm lớp: đất giữ nguyên cao độ lớp đang đầm và có xe lu.
- Kiểm tra cả bốn lớp minh họa: rải trước, đầm sau, cao độ giữ nguyên khi đầm; không đắp lớp kế tiếp trong cùng nửa chu kỳ đầm.
- Kiểm tra một lần chuyển xa trong Edge headless: 65 mẫu, tiến trình tăng liên tục, bước dịch camera lớn nhất khoảng 0,204 đơn vị mô hình và khoảng cách khung lớn nhất 19 ms. Đây là số đo của lượt thử trên máy tính, không là cam kết FPS trên điện thoại.
- Chuyển nhanh bốn góc chi tiết: dừng ở lựa chọn cuối, camera hội tụ. Nút phóng to có thay đổi khoảng cách camera. Các ảnh logo và hình chờ được tải thành công.
- Dừng và chạy tiếp giữ liên tục vị trí xe, không nhảy theo đồng hồ thực. Không có Canvas vẫn mở được tài chính. Mở file trực tiếp vẫn dùng mô hình Canvas dự phòng và bước lu/đầm.
- Giảm chuyển động giữ nguyên nội dung và cho phép chọn giai đoạn. Các luồng đã thử không phát sinh lỗi JavaScript.

## Phạm vi kiểm chứng

Phép tính và máy chủ được kiểm thử tự động; luồng nhập liệu đã được chạy qua trình duyệt sau khi đổi WebGL. Các lần đo tốc độ Canvas trong bản trước không được dùng để khẳng định hiệu năng WebGL. Chưa kiểm thử Android/iOS thật, Safari/Firefox, tải nhiều người đồng thời hoặc triển khai công khai. Chưa xác nhận tương thích với một bộ định mức, hợp đồng hay quy trình phê duyệt doanh nghiệp cụ thể.


## Bản bàn giao 18/10/2026, 23:55 (UTC+7)

- npm test đạt: 16 nhóm engine, 9 nhóm planner, mạng AOA/PERT/xiên, bố trí M phía trên và không đổi CPM khi kéo, tuyến vào–ra, auth/role/version, mời và bình luận, xóa/khôi phục chỉ owner.
- npm run test:browser đạt trên Edge headless Windows: camera không trùng liên kết cuộn ở 375/768/1440; kéo/lưu sơ đồ, sáu lựa chọn, Gantt từng ngày, stage Không, xóa/reload/restore; manual/basic/worker tối ưu, xuất báo cáo, invalidation; PDF/PNG/clipboard (clipboard dùng mock, không ghi clipboard máy kiểm thử); tuyến xe thực trong cảnh qua chuẩn bị–đào–đầm–đổ–kết cấu–quay lại chuẩn bị.
- Kiểm tra bổ sung 320/375/414/768/1440 cho trang đầu và 10 trang công cụ: không tràn ngang toàn trang.
- Cảnh có 12 tầng và 131 bước tăng đúng thứ tự; tám bước mẫu tầng 1 tạo trạng thái hình khác nhau. Các mặt đường không chồng diện tích, xe bồn không cắt thân xe bơm trên tuyến đã xét.
- npm audit: 0 lỗ hổng trong gói ứng dụng. Công cụ Ascii-Motion cài riêng không thuộc ứng dụng.
- Giới hạn: đây là kiểm tra theo kịch bản và miền test, không phải chứng nhận mô hình BIM, an toàn giàn giáo/cẩu, tối ưu toàn cục bài lớn hay không có mọi va chạm 3D. Cần duyệt trực quan khi thêm mô hình hay tuyến mới.


## Kiểm tra tuyến xe bổ sung 19/10/2026

`ui-fleet.cjs` mô phỏng 300 giây với 13 xe/thiết bị qua chuẩn bị → đào → đầm → đổ móng → kết cấu → về chuẩn bị. So sánh vị trí và góc thân xe đang vẽ, không chỉ trạng thái đặt chỗ. Kiểm tra không chồng thân, không nhảy vị trí, xe rời đi hết trước khi ẩn và xe trộn cấp liên tục với hai đuôi đối diện trong hai lượt đổ. Tách nhường đường, tuyến ra, khoang bê tông và góc quay thân xe. Kiểm tra này chưa chứng minh mọi tình huống vật lý có thể xảy ra khi sửa mô hình.
