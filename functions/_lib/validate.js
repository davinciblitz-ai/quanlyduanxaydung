// Kiểm tra dữ liệu dự án trước khi lưu — cùng quy tắc với server.cjs, dùng chung engine/planner/sơ đồ.
import CT from "../../engine.js";
import Planner from "../../planner.js";
import Networks from "../../networks.js";
import GraphBoard from "../../graph-board.js";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};
export const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export function text(v, name, min = 1, max = 200) {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) fail(400, name + " không hợp lệ.");
  return v.trim();
}
/** Ghi chú người dùng gửi kèm (mô tả thay đổi) — không bao giờ dùng làm nội dung nhật ký chính. */
export function note(v) {
  if (typeof v !== "string") return null;
  const clean = Array.from(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, 200).join("");
  return clean.trim() || null;
}

const PROJECT_FIELDS = [
  "id", "name", "currency", "start", "workdays", "holidays", "statusDay", "capacity", "indirectBase", "dailySaving",
  "tasks", "boq", "estimate", "finance", "risks", "baseline", "planning", "networkLayouts",
];

function validateProject(p) {
  text(p.id, "Mã dự án", 1, 64);
  if (!/^[A-Za-z0-9_-]+$/.test(p.id)) fail(400, "Mã dự án không hợp lệ.");
  text(p.name, "Tên dự án", 1, 160);
  if (!["VND", "USD"].includes(p.currency)) fail(400, "Loại tiền không hợp lệ.");
  CT.dateAt(p.start, 0, p.workdays, p.holidays);
  if (new Set(p.workdays).size !== p.workdays.length) fail(400, "Ngày làm việc trùng lặp.");
  CT.number(p.statusDay, "Ngày báo cáo", 0, 100000, true);
  CT.number(p.capacity, "Năng lực", 0, 100000, true);
  CT.number(p.indirectBase, "Chi phí gián tiếp");
  CT.number(p.dailySaving, "Giảm gián tiếp");
  GraphBoard.validateLayouts(p.networkLayouts);
  Networks.validateTasks(p.tasks);
  Planner.validate(p);
  if (Planner.active(p).duration > 100000) fail(400, "Tiến độ tối đa 100.000 ngày.");
  p.tasks.forEach((t) => {
    text(t.name, "Tên công việc", 1, 200);
    text(t.owner, "Phụ trách", 0, 160);
    if (t.stage !== undefined) CT.number(t.stage, "Giai đoạn", -1, 6, true);
  });
  CT.estimate(p.boq, p.estimate);
  const boqIds = new Set();
  p.boq.forEach((i) => {
    text(i.id, "Mã dự toán", 1, 64);
    if (boqIds.has(i.id)) fail(400, "Trùng mã dự toán.");
    boqIds.add(i.id);
    text(i.name, "Tên công tác", 1, 200);
    text(i.unit, "Đơn vị", 1, 20);
    text(i.task, "Mã công việc", 0, 24);
    if (i.task && !p.tasks.some((t) => t.id === i.task)) fail(400, "Dự toán gắn mã công việc không tồn tại.");
  });
  CT.loan(p.finance.principal, p.finance.rate, p.finance.months, p.finance.method);
  CT.appraisal(p.finance.flows, p.finance.discount);
  if (!Array.isArray(p.risks) || p.risks.length > 1000) fail(400, "Danh sách rủi ro không hợp lệ.");
  const riskIds = new Set();
  p.risks.forEach((r) => {
    text(r.id, "Mã rủi ro", 1, 64);
    if (riskIds.has(r.id)) fail(400, "Trùng mã rủi ro.");
    riskIds.add(r.id);
    text(r.name, "Tên rủi ro", 1, 300);
    text(r.owner, "Phụ trách", 0, 160);
    text(r.response, "Ứng phó", 0, 5000);
    CT.number(r.probability, "Xác suất", 1, 5, true);
    CT.number(r.impact, "Tác động", 1, 5, true);
    if (!["Đang theo dõi", "Đang xử lý", "Đã đóng"].includes(r.status)) fail(400, "Trạng thái rủi ro không hợp lệ.");
  });
  if (p.baseline) {
    CT.number(p.baseline.duration, "Thời lượng gốc", 0, 100000, true);
    if (!Array.isArray(p.baseline.rows) || p.baseline.rows.length > 150) fail(400, "Kế hoạch gốc không hợp lệ.");
    p.baseline.rows.forEach((t) => {
      text(t.id, "Mã công việc gốc", 1, 24);
      CT.number(t.es, "ES gốc", 0, 100000, true);
      CT.number(t.ef, "EF gốc", t.es, 100000, true);
    });
  }
}

/** Kiểm tra dự án gửi lên và chỉ giữ các trường đã biết ở cấp trên cùng. */
export function cleanProject(p) {
  if (!isPlainObject(p)) fail(400, "Thiếu dữ liệu dự án.");
  try {
    validateProject(p);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // engine/planner ném Error với thông điệp tiếng Việt cho người dùng.
    if (e && e.constructor === Error) fail(400, e.message);
    fail(400, "Dữ liệu dự án không hợp lệ.");
  }
  const next = {};
  for (const k of PROJECT_FIELDS) if (p[k] !== undefined) next[k] = p[k];
  next.history = [];
  return next;
}
