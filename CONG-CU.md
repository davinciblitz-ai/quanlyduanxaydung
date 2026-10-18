# Công cụ được cài theo yêu cầu trong chat

| Yêu cầu | Kết quả thực hiện |
|---|---|
| `npm install motion` | Đã cài Motion 14.3.0; dùng cho hiệu ứng vào trang và cuộn |
| `npx motion-ai` | Đã chạy Motion AI Kit 14.2.0 ở phạm vi dự án, chọn Codex; cài kỹ năng và cấu hình hai MCP Motion/Motion+ |
| `git clone feitangyuan/motion-web` | Đã clone vào `C:/Users/ktran/.agents/skills/motion-web`; dùng hướng dẫn cho trang giới thiệu và kiểm tra chuyển động |
| `npm install phy-touch` | Đã cài 0.2.2; dùng cho quán tính xoay trong nhánh Canvas dự phòng; WebGL dùng OrbitControls |
| `npx skills add oil-oil/oil-motion` | Đã cài kỹ năng trong `.agents/skills/oil-motion` của dự án. Bộ này phục vụ hoạt ảnh từ video/chuỗi khung; bản Quản lý dự án xây dựng hiện vẽ khối trực tiếp nên chưa tạo video bằng dịch vụ của kỹ năng |
| `npm install --save @wellyshen/use-web-animations` | Đã cài 0.9.1; được giữ để phát triển thành phần React về sau. Giao diện hiện tại dùng JavaScript thuần |
| Clone/cài Ascii-Motion | Đã clone vào `work/Ascii-Motion` của chat, `npm install` hoàn thành. Phiên bản repository 2.2.8; npm báo 10 lỗ hổng phụ thuộc. Công cụ này được giữ riêng, chưa tích hợp vào Quản lý dự án xây dựng |
| Three.js 0.186.1 | Cảnh WebGL thật, tài nguyên và giấy phép đóng gói trong vendor/ |
| NullToHero marketplace/plugin | Repository xác định hai lệnh marketplace là cho Claude Code; đã dùng trình cài PowerShell chính thức với `-Target codex`, cài 4 kỹ năng `nth-*` và 15 cấu hình tác vụ kiểm tra |

Motion MCP được cấu hình nhưng chưa được nạp thành công cụ trong phiên đang chạy. Hướng dẫn kèm gói và tài liệu công khai được dùng cho phần triển khai. Các kỹ năng mới được host nhận khi mở lượt/phiên mới theo cơ chế của host.

NullToHero được giữ tại `C:/Users/ktran/.agents/plugins/NullToHero` vì các kỹ năng tham chiếu công cụ trong checkout đó. Không xóa thư mục này nếu tiếp tục dùng bộ kỹ năng.

Gói ZIP bàn giao chỉ chứa ứng dụng, hướng dẫn, kiểm thử, tài nguyên giao diện và giấy phép; không kèm `node_modules`, SQLite, repository Ascii-Motion, các checkout kỹ năng hoặc cấu hình tài khoản của máy.

Nguồn: [Motion AI Kit](https://motion.dev/docs/ai-kit), [motion-web](https://github.com/feitangyuan/motion-web), [oil-motion](https://github.com/oil-oil/oil-motion), [use-web-animations](https://github.com/wellyshen/use-web-animations), [Ascii-Motion](https://github.com/cameronfoxly/Ascii-Motion), [NullToHero](https://github.com/MariusYvard/NullToHero).
