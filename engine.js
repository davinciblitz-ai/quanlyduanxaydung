/* Construction scheduling and financial calculations. No external dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const TYPES = ["FS", "SS", "FF", "SF"];
  const MAX_TASKS = 150;
  function number(v, label, min = 0, max = 1e15, integer = false) {
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    )
      throw new Error(label + ": giá trị không hợp lệ.");
    return v;
  }
  function weight(type, di, dj, lag) {
    return { FS: di + lag, SS: lag, FF: di - dj + lag, SF: -dj + lag }[type];
  }
  function schedule(tasks, { fractional = false } = {}) {
    if (!Array.isArray(tasks) || tasks.length > MAX_TASKS)
      throw new Error("Tối đa 150 công việc mỗi dự án.");
    const map = new Map(),
      incoming = new Map(),
      outgoing = new Map(),
      degree = new Map();
    tasks.forEach((t) => {
      if (!t || typeof t.id !== "string" || !/^[A-Za-z0-9_-]{1,24}$/.test(t.id))
        throw new Error("Mã công việc chỉ gồm chữ không dấu, số, _ hoặc -.");
      if (map.has(t.id)) throw new Error("Trùng mã công việc " + t.id + ".");
      if (typeof t.name !== "string" || !t.name.trim())
        throw new Error(t.id + ": thiếu tên công việc.");
      number(t.duration, t.id + " thời lượng", 0, 3650, !fractional);
      number(
        t.minDuration,
        t.id + " thời lượng tối thiểu",
        0,
        t.duration,
        !fractional,
      );
      const labels = { cost: "ngân sách", actualCost: "chi phí thực tế", crashSlope: "chi phí rút ngắn/ngày", workers: "nhân công" };
      ["cost", "actualCost", "crashSlope", "workers"].forEach((k) => number(t[k], t.id + " " + labels[k]));
      number(t.progress, t.id + " % hoàn thành", 0, 100);
      if (!Array.isArray(t.deps))
        throw new Error(t.id + ": quan hệ phải là danh sách.");
      map.set(t.id, t);
      incoming.set(t.id, []);
      outgoing.set(t.id, []);
      degree.set(t.id, 0);
    });
    const edges = [];
    tasks.forEach((t) => {
      const seen = new Set();
      t.deps.forEach((d) => {
        if (!d || !map.has(d.id))
          throw new Error(
            t.id + ": công việc trước không tồn tại (" + d?.id + ").",
          );
        if (d.id === t.id)
          throw new Error(t.id + ": không được phụ thuộc chính nó.");
        if (!TYPES.includes(d.type))
          throw new Error(t.id + ": quan hệ phải là FS, SS, FF hoặc SF.");
        number(d.lag, t.id + " độ trễ", -3650, 3650, true);
        const key = d.id + ":" + d.type;
        if (seen.has(key))
          throw new Error(t.id + ": quan hệ bị lặp " + key + ".");
        seen.add(key);
        const e = {
          from: d.id,
          to: t.id,
          type: d.type,
          lag: d.lag,
          w: weight(d.type, map.get(d.id).duration, t.duration, d.lag),
        };
        edges.push(e);
        incoming.get(t.id).push(e);
        outgoing.get(d.id).push(e);
        degree.set(t.id, degree.get(t.id) + 1);
      });
    });
    const queue = tasks.filter((t) => degree.get(t.id) === 0).map((t) => t.id),
      order = [];
    for (let n = 0; n < queue.length; n++) {
      const id = queue[n];
      order.push(id);
      outgoing.get(id).forEach((e) => {
        degree.set(e.to, degree.get(e.to) - 1);
        if (!degree.get(e.to)) queue.push(e.to);
      });
    }
    if (order.length !== tasks.length)
      throw new Error(
        "Quan hệ tạo vòng lặp. Kiểm tra: " +
          tasks
            .filter((t) => degree.get(t.id) > 0)
            .map((t) => t.id)
            .join(", ") +
          ".",
      );
    const rows = new Map();
    let duration = 0;
    order.forEach((id) => {
      const t = map.get(id),
        es = Math.max(
          0,
          ...incoming.get(id).map((e) => rows.get(e.from).es + e.w),
        );
      rows.set(id, { ...t, es, ef: es + t.duration });
      duration = Math.max(duration, es + t.duration);
    });
    [...order].reverse().forEach((id) => {
      const r = rows.get(id);
      r.ls = Math.min(
        duration - r.duration,
        ...outgoing.get(id).map((e) => rows.get(e.to).ls - e.w),
      );
      r.lf = r.ls + r.duration;
      r.tf = r.ls - r.es;
      if(fractional && Math.abs(r.tf)<1e-8)r.tf=0;
      r.ff = Math.min(
        duration - r.ef,
        ...outgoing.get(id).map((e) => rows.get(e.to).es - r.es - e.w),
      );
      r.critical = r.tf === 0;
    });
    edges.forEach((e) => {
      e.slack = rows.get(e.to).es - rows.get(e.from).es - e.w;
      e.critical =
        rows.get(e.from).critical && rows.get(e.to).critical && Math.abs(e.slack) < (fractional?1e-8:1e-15);
    });
    // Zero-float activities can be parallel or terminal at their finish even with successors.
    // Only connected, tight critical edges are returned as links; never join all red nodes into one path.
    return {
      duration,
      rows: tasks.map((t) => rows.get(t.id)),
      order,
      edges,
      critical: tasks.filter((t) => rows.get(t.id).critical).map((t) => t.id),
    };
  }
  function parseDeps(text) {
    if (!text.trim()) return [];
    return text
      .split(/[,;\n]+/)
      .filter((s) => s.trim())
      .map((s) => {
        const m = s
          .trim()
          .match(
            /^([A-Za-z0-9_-]{1,24})\s*(?::\s*(FS|SS|FF|SF)\s*([+-]\s*\d+)?)?$/i,
          );
        if (!m)
          throw new Error(
            "Sai quan hệ “" + s.trim() + "”. Ví dụ: A:FS+2, B:SS-1.",
          );
        return {
          id: m[1],
          type: (m[2] || "FS").toUpperCase(),
          lag: Number((m[3] || "0").replace(/\s/g, "")),
        };
      });
  }
  const depText = (deps) =>
    deps
      .map((d) => d.id + ":" + d.type + (d.lag >= 0 ? "+" : "") + d.lag)
      .join(", ");
  function optimize(tasks, indirectBase, dailySaving, limit = 50000) {
    const base = schedule(tasks);
    number(indirectBase, "Chi phí gián tiếp");
    number(dailySaving, "Tiết kiệm gián tiếp/ngày");
    let combinations = 1;
    // Công tác có thời lượng không bị rút thành mốc 0 ngày.
    const floor = (t) => Math.max(t.minDuration, t.duration > 0 ? 1 : 0);
    tasks.forEach((t) => {
      combinations *= Math.max(1, t.duration - floor(t) + 1);
    });
    if (combinations > limit)
      throw new Error(
        "Có " +
          combinations.toLocaleString("vi-VN") +
          " tổ hợp. Giới hạn tìm kiếm đầy đủ là " +
          limit.toLocaleString("vi-VN") +
          ". Hãy giảm khoảng rút ngắn hoặc cố định một số công việc.",
      );
    const work = tasks.map((t) => ({ ...t })),
      best = new Map();
    const baseCost = tasks.reduce((s, t) => s + t.cost, 0);
    function walk(index, extra) {
      if (index === tasks.length) {
        const result = schedule(work),
          d = result.duration,
          direct = baseCost + extra;
        if (!best.has(d) || direct < best.get(d).direct) {
          const indirect = Math.max(
            0,
            indirectBase - dailySaving * (base.duration - d),
          );
          best.set(d, {
            duration: d,
            direct,
            indirect,
            total: direct + indirect,
            reductions: work
              .map((t, i) => ({
                id: t.id,
                days: tasks[i].duration - t.duration,
              }))
              .filter((x) => x.days),
          });
        }
        return;
      }
      const t = tasks[index];
      for (let d = t.duration; d >= floor(t); d--) {
        work[index].duration = d;
        walk(index + 1, extra + (t.duration - d) * t.crashSlope);
      }
    }
    walk(0, 0);
    const scenarios = [...best.values()].sort(
      (a, b) => b.duration - a.duration,
    );
    return {
      combinations,
      scenarios,
      best: scenarios.reduce((a, b) => (b.total < a.total ? b : a)),
      baseDuration: base.duration,
    };
  }
  function estimate(items, settings) {
    if (!Array.isArray(items) || items.length > 1000)
      throw new Error("Tối đa 1.000 dòng dự toán.");
    const lines = items.map((i) => {
      ["qty", "material", "labor", "machine"].forEach((k) =>
        number(i[k], "Dự toán · " + { qty: "khối lượng", material: "đơn giá vật liệu", labor: "đơn giá nhân công", machine: "đơn giá máy" }[k]),
      );
      return { ...i, total: i.qty * (i.material + i.labor + i.machine) };
    });
    const labels = { overhead: "Tỷ lệ chi phí chung", contingency: "Tỷ lệ dự phòng", vat: "Thuế GTGT" };
    const profitRate = settings.profit ?? 0;
    ["overhead", "contingency", "vat"].forEach((k) => number(settings[k], labels[k], 0, 100));
    number(profitRate, "Thu nhập chịu thuế tính trước", 0, 100);
    number(settings.other, "Chi phí khác");
    // T trực tiếp → C chi phí chung = T × % → TL thu nhập chịu thuế tính trước = (T + C) × %
    const direct = lines.reduce((s, i) => s + i.total, 0),
      overhead = (direct * settings.overhead) / 100,
      profit = ((direct + overhead) * profitRate) / 100;
    const beforeReserve = direct + overhead + profit + settings.other,
      contingency = (beforeReserve * settings.contingency) / 100;
    const pretax = beforeReserve + contingency,
      vat = (pretax * settings.vat) / 100;
    return {
      lines,
      direct,
      overhead,
      profit,
      other: settings.other,
      contingency,
      pretax,
      vat,
      total: pretax + vat,
    };
  }
  function loan(principal, annualRate, months, method = "annuity") {
    number(principal, "Tiền vay");
    number(annualRate, "Lãi suất năm", 0, 100);
    number(months, "Số tháng", 1, 600, true);
    if (!["annuity", "principal"].includes(method))
      throw new Error("Phương thức trả nợ không hợp lệ.");
    const r = annualRate / 1200,
      payment =
        r === 0
          ? principal / months
          : (principal * r) / -Math.expm1(-months * Math.log1p(r));
    let balance = principal;
    const rows = [];
    for (let m = 1; m <= months; m++) {
      const interest = balance * r;
      const capital =
        m === months
          ? balance
          : Math.min(
              balance,
              method === "principal" ? principal / months : payment - interest,
            );
      balance = Math.max(0, balance - capital);
      rows.push({
        month: m,
        capital,
        interest,
        payment: capital + interest,
        balance,
      });
    }
    return {
      rows,
      interest: rows.reduce((s, x) => s + x.interest, 0),
      total: rows.reduce((s, x) => s + x.payment, 0),
      monthlyRate: r,
    };
  }
  function npv(flows, rate) {
    return flows.reduce((s, f, i) => s + f / Math.pow(1 + rate, i), 0);
  }
  function appraisal(flows, annualRate) {
    if (!Array.isArray(flows) || flows.length < 2 || flows.length > 101)
      throw new Error("Nhập từ 2 đến 101 dòng tiền (gồm kỳ 0).");
    flows.forEach((f) => number(f, "Dòng tiền", -1e15));
    number(annualRate, "Suất chiết khấu", 0, 100);
    const nonzero = flows.filter((x) => x !== 0),
      changes = nonzero.slice(1).filter((x, i) => x * nonzero[i] < 0).length;
    let irr = null,
      irrNote = "";
    if (changes !== 1)
      irrNote =
        changes > 1
          ? "Dòng tiền đổi dấu nhiều lần: có thể có nhiều IRR."
          : "Dòng tiền cần có ít nhất một khoản âm và một khoản dương.";
    else {
      let lo = -0.9999,
        hi = 10;
      if (npv(flows, lo) * npv(flows, hi) > 0)
        irrNote = "Không tìm thấy IRR trong khoảng −99,99% đến 1.000%/kỳ.";
      else {
        for (let n = 0; n < 160; n++) {
          const mid = (lo + hi) / 2;
          if (npv(flows, lo) * npv(flows, mid) > 0) lo = mid;
          else hi = mid;
        }
        irr = (lo + hi) / 2;
      }
    }
    let total = flows[0],
      payback = null;
    for (let i = 1; i < flows.length; i++) {
      const before = total;
      total += flows[i];
      if (payback === null && before < 0 && total >= 0 && flows[0] < 0)
        payback = i - 1 + -before / flows[i];
    }
    // Hoàn vốn có chiết khấu: cộng dồn giá trị hiện tại từng kỳ.
    const r = annualRate / 100;
    let pvTotal = flows[0], discountedPayback = null;
    for (let i = 1; i < flows.length; i++) {
      const before = pvTotal, pv = flows[i] / Math.pow(1 + r, i);
      pvTotal += pv;
      if (discountedPayback === null && before < 0 && pvTotal >= 0 && flows[0] < 0)
        discountedPayback = i - 1 + -before / pv;
    }
    // PI = PV dòng thu / PV dòng chi (giá trị tuyệt đối).
    let pvIn = 0, pvOut = 0;
    flows.forEach((f, i) => {
      const pv = f / Math.pow(1 + r, i);
      if (pv > 0) pvIn += pv;
      else pvOut -= pv;
    });
    return { npv: npv(flows, r), irr, irrNote, payback, discountedPayback, pi: pvOut > 0 ? pvIn / pvOut : null };
  }
  function evm(rows, statusDay) {
    number(statusDay, "Ngày báo cáo", 0, 100000, true);
    const bac = rows.reduce((s, t) => s + t.cost, 0),
      ev = rows.reduce((s, t) => s + (t.cost * t.progress) / 100, 0);
    const ac = rows.reduce((s, t) => s + t.actualCost, 0);
    const pv = rows.reduce(
      (s, t) =>
        s +
        t.cost *
          (t.duration
            ? Math.max(0, Math.min(1, (statusDay - t.es) / t.duration))
            : statusDay >= t.es
              ? 1
              : 0),
      0,
    );
    const cpi = ac ? ev / ac : null,
      spi = pv ? ev / pv : null,
      eac = ev > 0 && ac > 0 ? (bac * ac) / ev : null;
    return {
      bac,
      ev,
      ac,
      pv,
      cpi,
      spi,
      eac,
      cv: ev - ac,
      sv: ev - pv,
      // Dự báo khác: phần còn lại theo ngân sách / theo CPI × SPI.
      eacBudget: ac + bac - ev,
      eacCpiSpi: cpi && spi ? ac + (bac - ev) / (cpi * spi) : null,
      etc: eac === null ? null : eac - ac,
      vac: eac === null ? null : bac - eac,
      // TCPI: hiệu suất chi phí phần việc còn lại cần đạt để không vượt BAC.
      tcpi: bac - ac > 0 ? (bac - ev) / (bac - ac) : null,
      percentComplete: bac ? ev / bac : 0,
      percentSpent: bac ? ac / bac : 0,
    };
  }
  const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
  function parseHolidays(holidays) {
    if (holidays === undefined || holidays === null) return new Set();
    if (!Array.isArray(holidays) || holidays.length > 400)
      throw new Error("Danh sách ngày nghỉ lễ tối đa 400 ngày.");
    for (const h of holidays) {
      const d = new Date(h + "T00:00:00Z");
      if (typeof h !== "string" || !ISO_DAY.test(h) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== h)
        throw new Error("Ngày nghỉ lễ không hợp lệ: " + h);
    }
    return new Set(holidays);
  }
  function dateAt(start, offset, workdays, holidays) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start))
      throw new Error("Ngày khởi công không hợp lệ.");
    const date = new Date(start + "T00:00:00Z");
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== start
    )
      throw new Error("Ngày khởi công không hợp lệ.");
    if (
      !Array.isArray(workdays) ||
      !workdays.length ||
      workdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    )
      throw new Error("Chọn ít nhất một ngày làm việc trong tuần.");
    number(offset, "Mốc thời gian", 0, 100000, true);
    const off = parseHolidays(holidays);
    const working = () => workdays.includes(date.getUTCDay()) && !off.has(date.toISOString().slice(0, 10));
    while (!working()) date.setUTCDate(date.getUTCDate() + 1);
    for (let i = 0; i < offset; ) {
      date.setUTCDate(date.getUTCDate() + 1);
      if (working()) i++;
    }
    return date.toISOString().slice(0, 10);
  }
  return {
    schedule,
    parseDeps,
    depText,
    optimize,
    estimate,
    loan,
    appraisal,
    npv,
    evm,
    dateAt,
    parseHolidays,
    weight,
    number,
  };
});
