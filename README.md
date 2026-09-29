# LACA 24 — Laca Beer 24 · 24 Lý Quốc Sư, Hoàn Kiếm, Hà Nội

Website tĩnh (HTML/CSS/JS thuần, không build) + một serverless function gửi email đặt bàn.

```
index.html            nội dung, SEO, JSON-LD, dialog
style.css             mobile-first, token màu theo logo LACA (#FBB017, đỏ badge, đen)
script.js             menu mobile, form đặt bàn → POST /api/reservations, gallery, lightbox
lib/reservation.js    lõi xử lý đặt bàn: validate, chống spam, dựng email, gửi qua Resend
api/reservations.js   adapter Vercel  (POST /api/reservations)
netlify/functions/    adapter Netlify (POST /api/reservations) — chọn 1 trong 2 host
scripts/dev-server.mjs  server xem thử local (không cần cài gì, Node ≥ 18)
assets/laca24/        ảnh & logo chính thức (xem assets/laca24/SOURCES.md)
```

## Luồng đặt bàn

```
Form (script.js) → POST /api/reservations (JSON)
  → kiểm tra: content-type, kích thước, honeypot, thời gian điền form, rate limit theo IP,
    (tuỳ chọn) Cloudflare Turnstile, validate từng trường theo giờ Hà Nội
  → Resend API → email tới BOOKING_TO_EMAIL (manhquan281003@gmail.com)
  → 200 { ok, reference: "LACA-YYMMDD-XXXX", booking } → website hiện "Đã gửi yêu cầu – chờ nhà hàng xác nhận"
```

- Website **chỉ báo thành công khi server xác nhận email đã gửi**. Mọi lỗi (thiếu cấu hình 503, Resend lỗi 502, mất mạng, timeout, host không có API) → giữ nguyên dữ liệu trong form, hiện lỗi + nút gọi 093 636 8363 / Messenger.
- Không có hệ thống quản lý bàn: nội dung luôn nói đây là **yêu cầu**, nhà hàng gọi lại xác nhận.
- localStorage chỉ dùng cho tiện ích (khôi phục form nhập dở, xem lại mã yêu cầu vừa gửi) — không phải bản ghi đặt bàn.
- Email cho nhà hàng: tiêu đề `[LACA24] Đặt bàn mới — 19:00 05/10 — 4 khách — Nguyễn Văn A`, số điện thoại khách hiển thị to, bấm gọi được; `reply-to` là email khách (nếu có).
- Email xác nhận cho khách: tuỳ chọn (`SEND_CUSTOMER_ACK=true`), cần domain đã xác minh trong Resend. Lỗi gửi email cho khách không ảnh hưởng kết quả.

## Biến môi trường

| Biến | Bắt buộc | Ví dụ |
|---|---|---|
| `RESEND_API_KEY` | ✔ | `re_…` (resend.com → API Keys) |
| `BOOKING_TO_EMAIL` | ✔ | `manhquan281003@gmail.com` |
| `BOOKING_FROM_EMAIL` | ✔ | `LACA 24 Đặt bàn <onboarding@resend.dev>` hoặc `LACA 24 <datban@ten-mien-cua-ban.vn>` |
| `SEND_CUSTOMER_ACK` | | `false` (mặc định) / `true` |
| `ALLOWED_ORIGINS` | | `https://laca24.vn,https://www.laca24.vn` — để trống = chấp nhận mọi origin |
| `TURNSTILE_SECRET_KEY` | | chỉ đặt khi đã thêm widget Turnstile vào form |

Không bao giờ đưa key vào `script.js` hay commit file `.env` (đã có trong `.gitignore`).

> **Lưu ý Resend:** khi chưa xác minh domain, người gửi `onboarding@resend.dev` **chỉ gửi được tới email chủ tài khoản Resend**. Cách nhanh nhất: đăng ký Resend bằng chính `manhquan281003@gmail.com`. Muốn gửi email cho khách, hãy xác minh domain (Resend → Domains) rồi đổi `BOOKING_FROM_EMAIL`.

## Triển khai (Vercel — khuyến nghị)

1. Đẩy thư mục này lên GitHub (hoặc dùng `npx vercel` trong thư mục).
2. vercel.com → **Add New Project** → import repo. Framework preset: **Other**. Không cần build command, output directory để mặc định (thư mục gốc).
3. Project → Settings → **Environment Variables**: thêm `RESEND_API_KEY`, `BOOKING_TO_EMAIL`, `BOOKING_FROM_EMAIL` (Production + Preview). Redeploy.
4. `vercel.json` đã cấu hình header bảo mật (CSP, nosniff, frame, referrer) và cache ảnh.
5. Sau khi có domain: trong `index.html`, bỏ comment khối `canonical / og:url` và đổi `og:image`, `twitter:image` thành URL tuyệt đối `https://DOMAIN/assets/laca24/og/laca24-og-courtyard.jpg` (Facebook/Zalo cần URL tuyệt đối). Có thể thêm `"url"` và `"image"` tuyệt đối vào JSON-LD.

**Netlify (thay thế):** import repo, publish directory `.`, không build command; đặt các biến môi trường như trên. `netlify.toml` + `netlify/functions/reservations.mjs` đã sẵn sàng, endpoint vẫn là `/api/reservations`.

Hosting tĩnh thuần (GitHub Pages…) **không chạy được API** → form sẽ báo lỗi và hướng khách gọi điện (không bao giờ báo thành công giả).

## Chạy thử local

```bash
node scripts/dev-server.mjs --dry-run   # không gửi email; email được lưu thành file .outbox/*.html
node scripts/dev-server.mjs             # gửi email thật — cần file .env (copy từ .env.example)
node scripts/dev-server.mjs --fail-email  # giả lập Resend lỗi để xem màn hình lỗi
```
Mở http://localhost:8787.

## Gửi thử 1 email đặt bàn thật

1. Tạo tài khoản Resend bằng `manhquan281003@gmail.com`, tạo API key.
2. Đặt 3 biến bắt buộc trên Vercel (hoặc trong `.env` rồi chạy `node scripts/dev-server.mjs`).
3. Mở website → Đặt bàn → điền tên, **số điện thoại Việt Nam hợp lệ**, ngày/giờ trong tương lai, số khách, tick đồng ý → Gửi. (Chờ ≥ 3 giây sau khi tải trang — gửi quá nhanh bị coi là bot.)
4. Website hiện mã `LACA-…`. Kiểm tra hộp thư (cả mục Spam/Quảng cáo) của manhquan281003@gmail.com; đối chiếu log tại Resend → Emails và Vercel → Functions → Logs (`[reservations] delivered LACA-…`).

Kiểm tra nhanh bằng dòng lệnh:
```bash
curl -X POST https://DOMAIN/api/reservations -H "Content-Type: application/json" \
  -d '{"name":"Test LACA","phone":"0912345678","date":"2026-12-24","time":"19:00","guests":"4","area":"any","occasion":"casual","note":"test","consent":true,"website":"","startedAt":0}'
```

## Chống spam

Honeypot (`website`), thời gian điền form tối thiểu, rate limit 5 yêu cầu/10 phút/IP (theo từng instance serverless — mức cơ bản), giới hạn độ dài, escape HTML toàn bộ email, chặn xuống dòng trong tiêu đề. Nếu spam tăng: tạo Cloudflare Turnstile, đặt `TURNSTILE_SECRET_KEY`, thêm widget vào form và gửi token trong trường `turnstileToken` (nhớ bổ sung `https://challenges.cloudflare.com` vào CSP `script-src`/`frame-src`).

## Nội dung & dữ liệu

- Tất cả ảnh là ảnh chính thức của LACA 24 (nguồn: `assets/laca24/SOURCES.md`). Không còn ảnh Unsplash, review giả, giá/món giả hay sức chứa chưa xác minh.
- Menu: website không liệt kê món/giá; nút dẫn tới menu chính thức trên Facebook. Khi có menu mới xác nhận, có thể thêm vào mục `#menu`.
- Tuỳ chọn khu vực/số khách/dịp trong form phải khớp giữa `index.html`, `script.js` và `lib/reservation.js`.
