# Quản lý dự án xây dựng

Bản chạy thử gồm hai lối vào **Cá nhân** và **Doanh nghiệp / đội dự án**. Số liệu công trình và đơn giá đi kèm là dữ liệu minh họa; bài mẫu A–G được nhập từ tài liệu Word bạn cung cấp.

## Mở web

Máy cần **Node.js 22.13 trở lên**. Mở Terminal trong thư mục này và chạy:

```sh
npm ci
npm start
```

Mở **http://127.0.0.1:4173/**. Các tài nguyên giao diện đã nằm trong `vendor/`, nên không cần cài npm để chạy bản đã đóng gói. `npm install` dùng khi muốn cài lại những thư viện đã ghi trong package.json.

Bạn cũng có thể mở `index.html` trực tiếp để dùng công cụ cá nhân với mô hình Canvas dự phòng. WebGL dùng khi mở qua máy chủ HTTP. Dùng địa chỉ máy chủ ở trên sẽ bảo đảm font chữ, lưu dữ liệu và chế độ cộng tác hoạt động nhất quán.

## Bản web trên Cloudflare (dùng ngay, làm việc nhóm)

Mở **https://quanlyduanxaydung.pages.dev**.

- **Một mình:** chọn *Tôi làm cá nhân*. Dữ liệu lưu trên trình duyệt đang dùng (trang **Dự án của tôi**).
- **Cả nhóm:** chọn *Tôi quản lý đội dự án* → **Đăng nhập bằng Google** (lần đầu là tạo tài khoản) → trang **Dự án nhóm**.
  - *Đưa lên nhóm*: chép một dự án trên trình duyệt thành dự án dùng chung.
  - *Thành viên · mời bằng Gmail*: gõ Gmail bạn cùng nhóm và chọn quyền (chỉnh sửa / bình luận / chỉ xem). Người đó chỉ cần đăng nhập Google bằng đúng Gmail ấy là thấy dự án, mời trước khi họ có tài khoản cũng được. Vẫn có thể gửi liên kết mời dùng một lần (7 ngày).
  - Khi một người lưu, máy những người đang mở cùng dự án tự tải bản mới sau vài giây. Hai người sửa cùng lúc thì người lưu sau được báo để tải lại, không ghi đè âm thầm.
- Bài tập trong Dữ liệu QLDA.docx có sẵn: bài A–G (`/?project=nhom-qlda`) và bài 11 công tác A–K (`/?project=bai-a-k`).

Kiến trúc: trang tĩnh `dist/` + API `functions/api/[[path]].js` (Cloudflare Pages Functions) + CSDL **D1** `qlda` (bảng trong `migrations/`). Đăng nhập dùng Google ID token, máy chủ tự kiểm chữ ký RS256, không cần client secret. Cấu hình ở `wrangler.toml` (`GOOGLE_CLIENT_ID`, binding `DB`).

Cập nhật bản web:

```sh
npm run build:static
npx wrangler d1 migrations apply qlda --remote
npx wrangler pages deploy --branch main
```

Chạy thử bản Cloudflare trên máy (cần `.dev.vars` chứa `DEV_LOGIN=1` để có ô *Đăng nhập thử*; ô này tự tắt khi không chạy ở localhost):

```sh
npm run build:static
npx wrangler d1 migrations apply qlda --local
npx wrangler pages dev --port 8788
node tests/cloudflare-api.test.cjs
node tests/ui-team-cloudflare.cjs
```

Google Cloud → Google Auth Platform → Clients: *Authorized JavaScript origins* phải có `https://quanlyduanxaydung.pages.dev` (và `http://localhost:8788` để chạy thử). Nếu app ở chế độ *Testing*, thêm Gmail của các bạn trong nhóm vào *Audience → Test users*, hoặc bấm *Publish app*.

`npm start` (server.cjs + SQLite, đăng nhập bằng email/mật khẩu) vẫn dùng được cho mạng nội bộ.

## Bắt đầu trong hai chế độ

**Cá nhân:** vào Tổng quan, chọn Tiến độ để sửa công việc hoặc thêm mới. Dữ liệu tự lưu trên trình duyệt này. Xuất JSON để sao lưu toàn bộ dự án; CSV dùng cho bảng tiến độ, BOQ và lịch trả nợ.

**Đội dự án:** vào Danh mục, chọn Kết nối đội dự án. Lần đầu tạo tài khoản quản trị; sau đó vào Thành viên & lịch sử → Quản lý quyền → Tạo tài khoản. Tạo xong, quay lại Quản lý quyền để gán tài khoản vào dự án. Mỗi tài khoản dùng phiên đăng nhập riêng.

| Vai trò | Quyền |
|---|---|
| owner | Xem, sửa dự án, cấp quyền cho thành viên |
| editor | Xem và sửa dữ liệu dự án |
| commenter | Xem, xuất và bình luận; không sửa công việc |
| viewer | Xem và xuất dữ liệu; máy chủ từ chối sửa |

Quản trị không gian có quyền tạo tài khoản; quyền truy cập dữ liệu vẫn được kiểm tra theo dự án. Hai người sửa cùng phiên bản sẽ gặp cảnh báo xung đột. Khi gặp cảnh báo, xuất JSON nếu cần giữ các thay đổi đang xem, rồi chọn Tài khoản → Tải lại dự án trước khi chỉnh tiếp.

Tài khoản, dữ liệu và nhật ký được lưu vào `data/nen.sqlite`. Giữ cả thư mục `data/` khi sao lưu máy chủ; để sao chép SQLite nhất quán, dừng máy chủ bằng Ctrl+C trước khi sao chép. Không có tài khoản hay mật khẩu mặc định.

## Các công cụ

- **Thi công 3D:** mô hình WebGL có phối cảnh, ánh sáng, bóng đổ; kéo ngang để xoay, dùng +/− để phóng/thu hoặc căn vừa khung. Xe bồn có thùng quay và chu kỳ vào–dừng–ra; xe bơm, máy đào, xe ben và xe lu được huy động theo công tác, đi từ đường ngoài vào vị trí làm việc rồi đi ra. Bước chuẩn bị có mốc định vị và điện nước, chưa huy động xe bê tông. Có góc xem riêng cho thép móng, thép chờ, cột–dầm–sàn và mạch ngừng. Camera, tiến trình và các xe chuyển tiếp liên tục; hình chờ giữ cảnh trong lúc tải.
- **Trình tự công tác đất:** đào → lót, cốt thép/ván khuôn, bê tông móng → lấp đất sau khi đủ điều kiện. Bốn lớp minh họa lần lượt được rải rồi lu/đầm trước lớp tiếp. Xe lu chạy trên dải nền rộng phía sau nhà; vị trí hẹp quanh móng cần thiết bị đầm phù hợp. Các nút xem mẫu công tác đất ghi rõ chế độ minh họa, không đổi ngày hoặc dữ liệu CPM. Dự án mẫu mới có công việc lấp và đầm đất riêng; số ngày chờ là giả định kế hoạch.
- **Nhận diện:** xanh #032b91, xanh sáng #1488db và trắng, lấy từ báo cáo tham chiếu. Logo Bách Khoa TP.HCM trích từ ảnh có trong báo cáo.
- **CPM:** nhập mã, tên, thời lượng, FS/SS/FF/SF và lag âm/dương. Nhập theo danh sách gồm công tác trước, loại quan hệ, dấu +/− và số ngày. Tính ES, EF, LS, LF, TF, dự trữ riêng, quan hệ găng, Gantt từng ngày và mạng AON/AOA kéo thả, lưu bố cục và tải SVG.
- **Kế hoạch gốc:** lưu các mốc để so sánh thời lượng và vị trí thanh Gantt về sau.
- **Dự toán:** khối lượng × đơn giá vật liệu/nhân công/máy (T) → chi phí chung C = T × % → thu nhập chịu thuế tính trước TL = (T + C) × % → chi phí khác → dự phòng → thuế GTGT. Tỷ lệ do bạn nhập. Có thể tổng hợp các dòng gắn mã công việc thành ngân sách trực tiếp của công việc.
- **Chi phí:** EVM từ ngân sách, % hoàn thành và chi phí thực tế: PV, EV, AC, CV, SV, CPI, SPI, EAC (theo CPI, theo ngân sách, theo CPI × SPI), ETC, VAC, TCPI; phân tích rút ngắn với đường găng được tính lại ở mỗi tổ hợp (không rút công tác có thời lượng về 0 ngày).
- **Tài chính:** trả gốc đều hoặc trả tổng đều, dư nợ giảm dần, lãi đơn/lãi kép, PV/FV, NPV, IRR, chỉ số sinh lời PI, hoàn vốn giản đơn và hoàn vốn có chiết khấu. Dòng tiền nhập kiểu Việt Nam (`-1.000.000`, `2,5`).
- **Nguồn lực:** nhân công theo ngày, giới hạn năng lực, ngày vượt tải và phân công người phụ trách.
- **Rủi ro:** xác suất × tác động, sổ rủi ro, người xử lý và biện pháp ứng phó.

## Thử bài mẫu trong Word

Vào Tiến độ → Mở bài mẫu A–G → Chi phí & tối ưu → Phân tích rút ngắn.

Kết quả kiểm chứng: **25 ngày, trực tiếp 450 USD**; phương án tổng chi phí thấp nhất **22 ngày, trực tiếp 525 USD + gián tiếp 250 USD = 775 USD**. Đây là kết quả tìm đầy đủ 360 tổ hợp thời lượng nguyên trong giới hạn của bài mẫu, không phải chỉ rút một nhánh găng bằng thuật toán tham lam.

## Quy ước và giới hạn

- Tối đa 150 công việc/dự án, 100 dự án/không gian, 1.000 dòng BOQ. Bước thời lượng/lag là một ngày làm việc; lịch chung theo tuần, có danh sách ngày nghỉ lễ của dự án (Cài đặt dự án); chưa có lịch tổ đội riêng. Mạng quan hệ phải không có vòng.
- Mốc 0 là đầu ngày làm việc đầu tiên. EF = ES + thời lượng là ranh giới kết thúc. Ngày hoàn thành hiển thị ở tổng quan là ngày làm việc cuối cùng, tương ứng mốc T−1 khi T>0.
- Mô hình 3D là minh họa khối nhà 12 tầng minh họa cơ sở 2 Bách Khoa TP.HCM, chưa dựng theo bản vẽ đo đạc hay nhập mô hình IFC/BIM. % giai đoạn lấy từ ES/EF kế hoạch; không phải nghiệm thu thực tế.
- CPM cơ bản chưa san bằng nguồn lực. Tab Xếp & tối ưu có bộ lập lịch riêng (xem mục Xếp & tối ưu bên dưới). Phân tích rút ngắn tối đa 50.000 tổ hợp; nếu vượt giới hạn, giảm phạm vi rút ngắn hoặc cố định vài công việc. Chi phí tăng tuyến tính và chi phí gián tiếp được chặn tại 0.
- PV trong EVM dùng kế hoạch hiện tại, giả định chi phí phân bổ tuyến tính theo thời lượng; chưa dùng đường cơ sở chi phí hợp đồng. EAC giả định CPI giữ nguyên.
- Dự toán là mô hình nội bộ, chưa kết nối định mức, bộ đơn giá theo địa phương hay dữ liệu pháp luật. Thuế GTGT và thu nhập chịu thuế tính trước mặc định 0 và do bạn nhập; không tự chọn mức áp dụng theo văn bản pháp luật.
- Lãi vay cố định, danh nghĩa năm chia 12, giải ngân một lần, trả cuối tháng; chưa có phí, lãi thả nổi, ân hạn hoặc quy ước ngày thực tế của ngân hàng.
- Dòng tiền NPV/IRR theo các kỳ năm cách đều, kỳ 0 là thời điểm hiện tại. Dòng tiền đổi dấu nhiều lần sẽ không đưa ra một IRR duy nhất. Các máy tính tài chính không tự cộng vào dự toán để tránh cộng trùng.
- Máy chủ SQLite phục vụ thử nghiệm cục bộ hoặc nhóm nhỏ. Triển khai doanh nghiệp rộng cần bổ sung HTTPS, sao lưu tự động, quản trị danh tính và chính sách lưu trữ; các mục mở rộng nằm trong Hướng dẫn của web.

## Kiểm thử

```sh
npm test
```

Gồm 21 nhóm kiểm thử phép tính, 13 nhóm kiểm thử bộ xếp lịch (có đối chiếu với phép liệt kê độc lập trên bài ngẫu nhiên) và kiểm thử máy chủ: bài A–G, các loại quan hệ/lag, 200 mạng nhỏ đối chiếu mọi lịch nguyên khả thi, sai dữ liệu, dự toán, lãi vay, IRR, lịch làm việc, phiên đăng nhập, phân quyền và chống ghi đè. Kiểm thử trình duyệt và kết quả kiểm tra bổ sung được ghi trong `KIEM-THU.md`.

## Thư viện và công cụ đã cài theo yêu cầu

Three.js và Motion dùng cho cảnh 3D và chuyển giao diện; phy-touch dùng trong nhánh Canvas dự phòng; DOMPurify lọc HTML khi hiển thị dữ liệu. Font Be Vietnam Pro được đóng gói để hỗ trợ tiếng Việt và chạy offline. Giấy phép thư viện nằm trong `vendor/`.

`@wellyshen/use-web-animations` đã cài trong package.json để dùng khi phát triển thành phần React sau này. Bản hiện tại dùng JavaScript thuần. Motion AI Kit và oil-motion đã cài trong `.agents/skills/`; motion-web và NullToHero đã cài ở thư mục kỹ năng dùng chung của máy. Ascii-Motion được clone và cài riêng trong `work/Ascii-Motion` của chat; không nằm trong gói ứng dụng Quản lý dự án xây dựng.

## Những chức năng bổ sung trong bản bàn giao

- **Xếp & tối ưu:** ba phương thức (xếp tay / CPM cơ bản / thuật toán), kiểm tra đủ quan hệ và giới hạn trước khi áp dụng. Thuật toán có mục tiêu rõ ràng, so sánh theo thứ tự ưu tiên chứ không trộn trọng số:
  - *Giải toàn bộ dự án* → lịch **ngắn nhất** không vượt năng lực (hòa thì đỉnh thấp hơn, biểu đồ đều hơn).
  - *Điều hòa nhân lực* → **đỉnh Rmax** nhỏ nhất → thời gian ngắn nhất → ΣR² nhỏ nhất (biểu đồ đều) → ít người huy động.
  - *Tổng chi phí* → trực tiếp (gồm rút ngắn) + gián tiếp/ngày + huy động.

  Mọi mục tiêu đặt số ngày trễ hạn lên đầu. Bài ≤ 10 công tác dùng nhánh-cận duyệt đầy đủ mọi mốc bắt đầu nguyên (kết quả ghi "tối ưu đã chứng minh"); bài lớn dùng xếp nối tiếp theo nhiều luật ưu tiên, dồn tiến–lùi và tìm kiếm cục bộ lặp, kèm **cận dưới lý thuyết** (đỉnh ≥ max(nhân công lớn nhất, tổng công ÷ hạn), thời gian ≥ max(CPM, tổng công ÷ năng lực)) để thấy khoảng cách tới tối ưu. Dự trữ của lịch đã bố trí được tính lùi có xét năng lực, nên hai việc phải nối nhau vì thiếu người đều là găng.
- **Điều hòa nhân lực:** Rmax, Rtb = S/T, hệ số không điều hòa K1 = Rmax/Rtb, hệ số phân bố K2 = Sdư/S, tổng công S, số người huy động thêm; biểu đồ có đường năng lực và đường Rtb. Giới hạn nhân lực tổng hợp, không ngắt quãng công tác. Chưa phân nghề, tăng ca, máy hữu hạn hoặc năng suất thực tế. Hàm mục tiêu chưa đưa lãi vay vào tối ưu lịch; máy tính tài chính là phần riêng.
- **Sơ đồ:** AON/PDM nút tròn hoặc thẻ, AOA cổ điển FS với lag không âm, Gantt, Gantt liên kết, tiến độ xiên theo phân đoạn, PERT ba ước lượng. AOA dùng công tác giả, chưa tối thiểu hóa số sự kiện. Mạng không phẳng có thể còn giao tuyến; đường tránh vuông góc và khoảng ngắt giúp phân biệt. Người dùng có thể kéo nút, đổi bố trí, lưu, khôi phục tự động và xuất SVG. Các thao tác này không đổi quan hệ CPM.
- **In & xuất** ở cuối thanh bên: chọn nhiều mục, in, PDF, PNG/ZIP hoặc ảnh clipboard. Mỗi trang có nút sao chép/xuất nhanh. Sơ đồ lớn chia thành các ô có biên chồng khi xuất để giữ cỡ chữ. PDF tự động là ảnh; dùng In nếu cần văn bản có thể chọn.
- **Cộng tác:** mời bằng liên kết một lần, hết hạn 48 giờ; quyền owner/editor/commenter/viewer; bình luận, nhật ký và kiểm tra phiên bản khi lưu. Liên kết localhost chỉ dùng được trên máy này. Khi triển khai cho người khác phải dùng địa chỉ máy chủ chung.
- **Xóa dự án:** Cá nhân có danh sách khôi phục, dự án mẫu đã xóa không tự mọc lại. Máy chủ chỉ cho owner xóa/khôi phục và kiểm tra phiên bản trước khi xóa.
- **Thi công 3D:** 131 bước theo thứ tự, 12 tầng, cốp pha/cây chống theo từng tầng, bảo dưỡng và tháo luân chuyển, giàn giáo chữ X, sàn công tác và cầu thang. Khi chọn bước của tầng, camera chuyển đến tầng đó; bấm Công trình để xem toàn cảnh. Các con số bảo dưỡng trong mô phỏng không phải chỉ dẫn tháo chống ngoài hiện trường.
- **Bài Word:** dự án có sẵn tên `nhóm quản lý dự án`. Mở `/?project=nhom-qlda`. Dữ liệu đề không cho nhân công/lãi vay nên giữ các thành phần này là chưa nhập.

## Hỗ trợ người cùng phát triển

Xem [HANDOFF.md](HANDOFF.md) để biết cấu trúc mã, lệnh kiểm thử và giới hạn. Xem [CONTRIBUTING.md](CONTRIBUTING.md) trước khi sửa phần tính toán hoặc chuyển động.

```sh
npm test
# Tùy chọn: kiểm tra trình duyệt sau khi cài npm
npx playwright install chromium
npm run test:browser
```

Các bài kiểm thử máy chủ và trình duyệt dùng cơ sở dữ liệu tạm, không sửa `data/nen.sqlite` đang dùng. `node_modules/`, tài khoản, phiên đăng nhập, SQLite, dữ liệu cá nhân trong trình duyệt và tài liệu gốc người dùng không nằm trong Git.


### Tuyến xe và cấp bê tông

Mọi xe dùng vùng thân hình chữ nhật xoay để giữ khoảng cách, kể cả khi rẽ; xe bị chặn sẽ chờ. Máy thi công có tuyến vào/ra riêng và dùng cổng lần lượt. Xe đường phố chạy vòng kín. Xe bơm vào khoang phía phải trước; xe trộn lùi vào, hai đuôi đối diện, máng xả nối tới phễu nhận. Trong khi bơm, xe trộn giữ nguyên vị trí cấp; chỉ bơm khi cả hai xe ở đúng vị trí. Chưa mô phỏng dung tích bồn, tốc độ bơm và đổi ca xe trộn.
