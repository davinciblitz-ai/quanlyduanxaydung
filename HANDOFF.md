# Bàn giao kỹ thuật · 18/10/2026

## Chạy

Node.js 22.13+ (khuyến nghị Node 24), `npm ci`, `npm start`, mở http://127.0.0.1:4173. Không có bước build. Tài nguyên chính đã vendor để chạy offline. Mặc định máy chủ chỉ lắng nghe loopback. Có thể cấu hình `PORT`, `HOST`, `NEN_DATA_DIR`; triển khai công khai cần HTTPS và cấu hình vận hành phù hợp.

## Bản đồ mã

| File | Trách nhiệm |
|---|---|
| engine.js | CPM, quan hệ/lag, dự trữ, crashing, BOQ, EVM, tài chính/lịch |
| planner.js / planner-worker.js | Lịch thủ công/cơ bản/thuật toán, nguồn lực, so sánh và miền tìm kiếm |
| networks.js / graph-board.js | AOA, PERT, tiến độ xiên, bố trí nút và đường tránh |
| app.js | Điều hướng, form, lưu cá nhân, gọi API, báo cáo, kéo thả sơ đồ |
| server.cjs | HTTP, SQLite, tài khoản/session, quyền, lời mời, bình luận, phiên bản, xóa/khôi phục |
| construction-sequence.js | Danh sách 131 bước minh họa |
| webgl-scene.js / fleet.js | Cảnh Three.js, thi công từng tầng, cẩu, tuyến xe và huy động |
| scene.js / equipment.js / reinforcement.js | Canvas dự phòng và mô tả thiết bị/thép |
| print-export.js | In, PDF, PNG/ZIP, clipboard ảnh |
| samples.js | Dữ liệu minh họa và bài Word A–G |
| tests/ | Phép tính, quyền máy chủ, bố trí, tuyến xe và trình duyệt |

## Lưu và cộng tác

Cá nhân lưu localStorage `nen.workspace.v1`. Xuất JSON để chuyển dữ liệu sang máy khác. Đội dự án lưu SQLite ở `data/nen.sqlite`; không commit file này. Dừng máy chủ trước khi sao lưu cả thư mục data. Lời mời chứa token dùng một lần, máy chủ chỉ lưu hash. Không có mật khẩu mặc định. Phiên bản dự án tránh ghi đè âm thầm khi hai người sửa.

## Kiểm tra trước khi gửi thay đổi

`npm test`. `npm run test:browser` chạy máy chủ tạm ở cổng 4193; Windows dùng Edge, Linux/macOS dùng Chromium đã cài bằng Playwright. Đổi `PW_CHANNEL` nếu cần. Báo cáo chụp màn hình ở `test-results/`. Chạy `npm audit` khi đổi thư viện.

## Các giới hạn cần giữ rõ

Bộ tối ưu nguồn lực hiện có một nhóm người tổng hợp, công tác liên tục, bước ngày nguyên, không lịch nghề hay ca. Bài lớn dùng heuristic có giới hạn thời gian và không đảm bảo tối ưu toàn cục. Nhu cầu công tác khi rút ngắn được tăng theo hao phí ngày công, làm tròn lên. Chi phí trực tiếp đã có nhân công, không cộng lại đơn giá ngày công; chi phí huy động là thành phần riêng.

Mô hình 3D mang tính minh họa kiến trúc 12 tầng cơ sở 2, không phải bản sao đo đạc hay BIM được phê duyệt. Cẩu và tuyến xe là kịch bản, chưa phải mô phỏng va chạm vật lý toàn công trường. Dữ liệu giá minh họa không thay thế bộ đơn giá/định mức địa phương. PERT mới có thời gian kỳ vọng và phương sai từng công tác, chưa mô phỏng Monte Carlo xác suất hoàn thành dự án.

## Gợi ý chia việc

Người sửa tính toán làm trong engine/planner và bổ sung test độc lập. Người sửa cảnh tập trung webgl-scene/fleet/construction-sequence. Người sửa giao diện tập trung app và CSS. Những nhóm này dùng chung samples/API nên cần trao đổi trước khi đổi schema. Không thay `node_modules` hoặc vendor bằng sửa tay mà không ghi phiên bản và giấy phép.
