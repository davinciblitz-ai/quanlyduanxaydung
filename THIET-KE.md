# Hướng thiết kế và lựa chọn sản phẩm

## Hai không gian, một bộ máy tính

Cá nhân cần vào nhanh, học quy luật và thử phương án. Đội dự án cần danh mục, người phụ trách, quyền truy cập và nguồn dữ liệu chung. Vì vậy màn hình đầu tách hai lối vào, còn tiến độ–chi phí–tài chính dùng chung bộ tính. Việc này tránh kết quả khác nhau giữa màn hình cá nhân và màn hình điều hành.

Điểm chính của bản này là nối BOQ với mã công việc và nối các giai đoạn 3D với ES/EF. Mỗi kết quả đều đi cùng dữ liệu đầu vào và giả định. Dữ liệu mẫu tách khỏi dữ liệu người dùng; mở bài mẫu tạo dự án mới để giữ lại công trình đang làm.

## Tham khảo sản phẩm

Đã đọc thông tin công khai ngày 18/10/2026. Đây là nghiên cứu tài liệu sản phẩm, chưa phải thử nghiệm sử dụng đầy đủ, đánh giá giá mua hoặc xếp hạng phần mềm.

| Nguồn | Điều chọn học | Cách áp dụng |
|---|---|---|
| [FastdoWork và danh sách Fastdo](https://fastdo.vn/phan-mem-quan-ly-du-an-xay-dung/) | Lập kế hoạch, giao việc, quy trình, cộng tác | Lối vào đơn giản, người phụ trách và trạng thái rõ ràng |
| [Oracle Primavera P6](https://www.oracle.com/construction-engineering/primavera-p6/) | CPM, nhiều dự án, nhu cầu/năng lực nguồn lực, kịch bản và kết nối chi phí–tiến độ | CPM tổng quát, Gantt, AON, danh mục, tải nhân công và so sánh rút ngắn |
| [Procore Financial Management](https://www.procore.com/financial-management) | Ngân sách và dữ liệu hiện trường gắn với dự báo, thay đổi, thanh toán | BOQ → ngân sách công việc, thực tế/EVM và nhật ký; hợp đồng và thanh toán phát triển sau |
| [MISA AMIS Công Việc](https://amis.misa.vn/amis-cong-viec/) | Phân công, lịch sử, các góc nhìn tiến độ và quyền theo dự án | Người phụ trách, phân quyền máy chủ và lịch sử cập nhật |
| [Hệ phần mềm GXD](https://gxd.vn/) | Nghiệp vụ xây dựng tách riêng dự toán, chất lượng, quyết toán | Tổ chức các công cụ chuyên môn thành từng màn hình; chuẩn bị chỗ cho định mức và hồ sơ chất lượng |

Đã thử truy cập thêm trang Autodesk Build, Microsoft Planner và Buildertrend nhưng máy chủ của các trang đó chặn truy cập trong phiên nghiên cứu; không dùng nội dung chưa đọc để đưa ra nhận định so sánh.

Lựa chọn “phù hợp nhất” ở đây là giữ lõi tiến độ và tài chính rõ ràng, đồng thời có đường mở rộng cộng tác. Không khẳng định một phần mềm có thể tối ưu mọi loại công trình, quy mô tổ chức hoặc quy trình pháp lý.

## Chuyển động và trình tự thi công

Hai video bạn gửi được dùng làm tham khảo nhịp chuyển cảnh, chiều sâu và kể chuyện bằng cuộn. Không đưa khung hình, nhãn hiệu hay tài sản của video vào sản phẩm.

Concept: công trình hình thành từ nền lên. Trang đầu chỉ có một mô hình tương tác, sau đó là nhóm công cụ và lựa chọn không gian. Đã bỏ cảnh 3D thứ hai vì lặp nội dung và kéo dài trang. Trang Thi công 3D trong không gian dự án dùng để xem chi tiết, tách khỏi phần giới thiệu. Giao diện tính toán dùng nhịp chuyển động ngắn, bố cục ổn định và khả năng thao tác bằng bàn phím.

Trình tự chuyên môn tham khảo CI5405 C2 trang 25: ngoài trước trong sau, ngầm trước nổi, kết cấu từ dưới lên và hoàn thiện từ trên xuống. Chi tiết móng tham khảo CI5405 C3 trang 17, 24. Mô hình là khối minh họa, không phải thiết kế kết cấu hay quy trình thi công được phê duyệt cho một công trường cụ thể.

Three.js vẽ WebGL với phối cảnh, vật liệu, ánh sáng và bóng đổ; OrbitControls xử lý xoay. Camera và tiến độ nội suy theo thời gian khung hình, xe chuyển độ mờ khi đổi công tác. Motion điều khiển phần xuất hiện và View Transitions chuyển trang công cụ. Nhánh file trực tiếp dùng Canvas dự phòng và phy-touch. Có nút dừng chuyển động tự động, giảm chuyển động theo hệ điều hành và dừng vẽ cảnh khi ngoài khung nhìn. Thiết bị di động dùng cuộn trang gốc, không chiếm thao tác cuộn để xoay mô hình.

## Những phần cần bổ sung để dùng rộng trong doanh nghiệp

Ưu tiên tiếp theo theo mức độ tác động: lịch tổ đội/ngày lễ và nhập dữ liệu Excel; định mức và bộ đơn giá có phiên bản; hợp đồng–phát sinh–phê duyệt; kế hoạch chi phí gốc và dòng tiền hợp nhất; quản lý tài liệu, RFI, nhật ký, nghiệm thu; cân bằng nguồn lực; nhập IFC/BIM và liên kết cấu kiện; quản trị danh tính, sao lưu, PostgreSQL và triển khai HTTPS.

Các mục này được nêu là phần mở rộng, không hiển thị thành tính năng đã hoạt động trong bản chạy thử.

## Bổ sung máy thi công

Đã bổ sung xe bồn trộn bê tông chạy vào–dừng–rời công trường, xe bơm với cần và dòng đổ, máy đào với gầu chuyển động, xe ben và xe lu. Các đối tượng được vẽ trong cùng hệ tọa độ và thứ tự che khuất với công trình; không dùng video hoặc mô hình tải ngoài.

Địa hình hố móng được khoét thực trong khối nền minh họa, có các mặt thành đất và đáy thấp hơn mặt bằng. Đất lấp nâng dần đáy; các đống đất thu nhỏ theo giai đoạn lấp. Thiết bị xuất hiện theo giai đoạn, không dùng làm thông số biện pháp thi công hoặc tính năng suất. Các nút giai đoạn chuyển đến ES/EF của công việc đã gắn giai đoạn; các nút xem công tác đất ghi rõ minh họa và không sửa dữ liệu tiến độ. Mỗi lớp đất được rải rồi lu/đầm trước lớp kế tiếp; xe lu chỉ vẽ trên dải rộng. Móng được làm trước khi lấp đất quanh móng.


## Đối chiếu trình tự công tác đất

- Tài liệu người dùng CI5405 C3, trang 17 và 24: đào đất, bê tông lót, cốt thép, ván khuôn, bê tông móng, tháo khuôn và lấp đất. C2 trang 25 cung cấp nguyên tắc tổ chức chung. Thời gian chờ trong bài tập là giả thiết riêng, không là thời gian bảo dưỡng chung cho mọi công trình.
- [Danh mục VSQI: TCVN 4447:2012](https://tieuchuan.vsqi.gov.vn/tieuchuan/view?sohieu=TCVN+4447%3A2012) xác nhận tên và phạm vi tiêu chuẩn công tác đất. Trang danh mục không cung cấp toàn văn điều khoản; không gán số điều chưa đọc cho mô hình.
- [FHWA, Soils and Foundations, Volume I](https://www.fhwa.dot.gov/engineering/geotech/pubs/nhi06088.pdf), mục 5.8 và 7.2, bảng 7-1: đối chiếu cơ chế đầm chặt, lựa chọn thiết bị và khó khăn khi đầm trong khu vực hẹp gần kết cấu. Đây là nguồn kỹ thuật đối chiếu, không thay thế tiêu chuẩn áp dụng cho công trình Việt Nam.

Bốn lớp đắp, hình dạng hố và vị trí mạch ngừng chỉ phục vụ diễn họa. Chiều dày lớp, độ ẩm, thiết bị, độ chặt, chống đỡ hố đào và điều kiện lấp đất phải theo thiết kế, thí nghiệm và biện pháp được duyệt; ứng dụng chưa tính các thông số đó.
