/* Bộ xếp lịch: công tác không ngắt quãng, thời lượng ngày nguyên, một nhóm nhân lực tổng hợp.
 *
 * - Xếp tay / CPM cơ bản: kiểm tra quan hệ FS/SS/FF/SF (có lag), năng lực và hạn hoàn thành.
 * - Thuật toán: tối ưu theo một mục tiêu rõ ràng, so sánh theo thứ tự ưu tiên (từ điển):
 *     time      – thời gian ngắn nhất trong giới hạn nhân lực → đỉnh → ΣR² → huy động → chi phí
 *     workforce – điều hòa nhân lực: đỉnh → thời gian → ΣR² (độ đều) → số người huy động → chi phí
 *     cost      – tổng chi phí (trực tiếp + gián tiếp/ngày + huy động) → đỉnh → ΣR² → thời gian
 *   Mọi mục tiêu đặt "số ngày trễ hạn" lên đầu nên lịch đúng hạn luôn thắng lịch trễ hạn.
 *   Bài nhỏ: nhánh-cận duyệt đầy đủ (chứng minh tối ưu trong miền ngày nguyên đã xét).
 *   Bài lớn: xếp nối tiếp theo nhiều luật ưu tiên, cải thiện tiến–lùi (forward–backward
 *   justification) và tìm kiếm cục bộ lặp; mỗi bước dịch một công tác được đánh giá O(1)
 *   bằng tổng tiền tố, cửa sổ trượt cực đại và chênh lệch đầu–cuối cửa sổ.
 */
(function (root, factory) {
  const api = factory(
    typeof module === "object" && module.exports ? require("./engine.js") : root.CT,
  );
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (CT) {
  "use strict";

  const MODES = ["manual", "basic", "algorithm"];
  const GOALS = ["analyze", "optimize"];
  const PRIORITIES = ["time", "workforce", "cost"];
  // Dữ liệu cũ lưu "balanced" (trộn trọng số). Nay hiểu là điều hòa nhân lực.
  const LEGACY_PRIORITY = { balanced: "workforce" };
  const defaults = {
    strategy: "basic",
    goal: "analyze",
    priority: "workforce",
    capacity: 30,
    maxDuration: 60,
    indirectPerDay: 0,
    mobilizationRate: 0,
    allowCrash: false,
  };
  const EPS = 1e-9;
  const MAX_DAYS = 100000;

  function options(value = {}, project = {}) {
    const base = CT.schedule(project.tasks || []);
    const o = {
      ...defaults,
      capacity: project.capacity ?? 30,
      maxDuration: Math.min(3000, Math.max(base.duration, Math.ceil(base.duration * 1.25))),
      ...value,
    };
    if (Object.hasOwn(LEGACY_PRIORITY, o.priority)) o.priority = LEGACY_PRIORITY[o.priority];
    if (!MODES.includes(o.strategy) || !GOALS.includes(o.goal) || !PRIORITIES.includes(o.priority))
      throw Error("Lựa chọn cách xếp hoặc mục tiêu không hợp lệ.");
    CT.number(o.capacity, "Giới hạn nhân công", 0, 100000, true);
    CT.number(o.maxDuration, "Hạn hoàn thành", 0, 100000, true);
    CT.number(o.indirectPerDay, "Gián tiếp/ngày");
    CT.number(o.mobilizationRate, "Huy động/người");
    if (typeof o.allowCrash !== "boolean") throw Error("Cấu hình rút ngắn không hợp lệ.");
    return o;
  }

  /** "Giải toàn bộ dự án" bằng thuật toán = lịch ngắn nhất thỏa năng lực. */
  const objective = (o) => (o.goal === "optimize" ? o.priority : "time");

  function fingerprint(tasks) {
    return JSON.stringify(
      tasks.map((t) => [
        t.id, t.duration, t.minDuration, t.cost, t.crashSlope, t.workers,
        t.deps.map((d) => [d.id, d.type, d.lag]),
      ]),
    );
  }

  const durationFloor = (t) => Math.max(t.minDuration, t.duration > 0 ? 1 : 0);

  /** Thời lượng phương án: rút ngắn tăng chi phí theo độ dốc và tăng người để giữ hao phí ngày công. */
  function effective(tasks, durations = {}) {
    return tasks.map((t) => {
      const duration = Object.hasOwn(durations, t.id) ? durations[t.id] : t.duration;
      CT.number(duration, t.id + " thời lượng phương án", t.minDuration, t.duration, true);
      if (t.duration > 0 && duration === 0)
        throw Error(t.id + ": không rút công tác có thời lượng thành mốc 0 ngày.");
      return {
        ...t,
        duration,
        cost: t.cost + (t.duration - duration) * t.crashSlope,
        workers:
          duration < t.duration && duration > 0
            ? Math.ceil((t.workers * t.duration) / duration)
            : t.workers,
      };
    });
  }

  function profile(tasks, starts) {
    const duration = Math.max(0, ...tasks.map((t) => (starts[t.id] ?? 0) + t.duration));
    if (duration > MAX_DAYS) throw Error("Tiến độ tối đa 100.000 ngày.");
    const diff = new Float64Array(duration + 1);
    for (const t of tasks)
      if (t.duration) {
        diff[starts[t.id]] += t.workers;
        diff[starts[t.id] + t.duration] -= t.workers;
      }
    const crew = new Array(duration);
    let v = 0;
    for (let i = 0; i < duration; i++) {
      v += diff[i];
      crew[i] = Math.abs(v) < EPS ? 0 : v;
    }
    return crew;
  }

  /**
   * Chỉ tiêu biểu đồ nhân lực.
   *  K1 = Rmax / Rtb (hệ số không điều hòa), K2 = Sdư / S (hệ số phân bố lao động),
   *  Sdư là phần công vượt đường trung bình Rtb = S / T.
   *  valley/unimodal giữ để tương thích: valley = 0 khi biểu đồ chỉ tăng đến đỉnh rồi giảm.
   */
  function metrics(crew) {
    let prev = 0, variation = 0, mobilizations = 0, work = 0, peak = 0;
    let squaredChange = 0, sumSquares = 0;
    for (const n of [...crew, 0]) {
      const delta = n - prev;
      variation += Math.abs(delta);
      squaredChange += delta * delta;
      if (delta > 0) mobilizations += delta;
      if (n > peak) peak = n;
      work += n;
      sumSquares += n * n;
      prev = n;
    }
    const duration = crew.length, average = duration ? work / duration : 0;
    let surplus = 0;
    for (const n of crew) if (n > average) surplus += n - average;
    return {
      duration,
      peak,
      work,
      variation,
      mobilizations,
      valley: Math.max(0, variation - 2 * peak),
      squaredChange,
      sumSquares,
      unimodal: variation - 2 * peak < 1e-8,
      average,
      k1: average ? peak / average : 0,
      k2: work ? surplus / work : 0,
    };
  }

  function inspect(tasks, starts, o) {
    const base = CT.schedule(tasks), issues = [];
    for (const t of tasks)
      if (
        !Object.hasOwn(starts, t.id) ||
        !Number.isInteger(starts[t.id]) ||
        starts[t.id] < 0 ||
        starts[t.id] + t.duration > MAX_DAYS
      )
        issues.push({ kind: "start", task: t.id, message: t.id + ": nhập mốc bắt đầu nguyên không âm." });
    if (issues.length) return { valid: false, issues };
    for (const e of base.edges)
      if (starts[e.to] < starts[e.from] + e.w)
        issues.push({
          kind: "relation",
          task: e.to,
          message:
            e.from + " → " + e.to + " (" + e.type + (e.lag >= 0 ? "+" : "") + e.lag + "): vi phạm " +
            (starts[e.from] + e.w - starts[e.to]) + " ngày.",
        });
    const crew = profile(tasks, starts), m = metrics(crew);
    const over = crew.filter((n) => n > o.capacity + EPS).length;
    if (over)
      issues.push({ kind: "capacity", message: over + " ngày vượt năng lực " + o.capacity + " người; đỉnh " + m.peak + " người." });
    if (m.duration > o.maxDuration)
      issues.push({ kind: "deadline", message: "Vượt hạn hoàn thành " + (m.duration - o.maxDuration) + " ngày." });
    const direct = tasks.reduce((s, t) => s + t.cost, 0);
    const indirect = m.duration * o.indirectPerDay, mobilization = m.mobilizations * o.mobilizationRate;
    return {
      valid: issues.length === 0,
      issues,
      crew,
      metrics: { ...m, overDays: over },
      costs: { direct, indirect, mobilization, total: direct + indirect + mobilization },
    };
  }

  function candidate(original, durations, starts, o) {
    const tasks = effective(original, durations), check = inspect(tasks, starts, o);
    if (!check.crew) return { ...check, starts: { ...starts }, durations: { ...durations } };
    const plan = {
      ...check,
      starts: { ...starts },
      durations: Object.fromEntries(tasks.map((t) => [t.id, t.duration])),
      cpm: CT.schedule(tasks),
    };
    plan.rank = rank(plan, o);
    return plan;
  }

  // ---------- So sánh phương án ----------

  function keyOf(obj, late, T, peak, sumSq, mob, cost) {
    if (obj === "time") return [late, T, peak, sumSq, mob, cost];
    if (obj === "cost") return [late, cost, peak, sumSq, T];
    return [late, peak, T, sumSq, mob, cost];
  }
  function rank(plan, o) {
    const m = plan.metrics, c = plan.costs;
    return keyOf(objective(o), Math.max(0, m.duration - o.maxDuration), m.duration, m.peak, m.sumSquares, m.mobilizations, c.total);
  }
  function cmp1(a, b) {
    const tol = 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    return a < b - tol ? -1 : a > b + tol ? 1 : 0;
  }
  function compareKeys(a, b) {
    for (let k = 0; k < a.length; k++) {
      const c = cmp1(a[k], b[k]);
      if (c) return c;
    }
    return 0;
  }
  /** Âm nếu p tốt hơn q theo mục tiêu của o. Lịch hợp lệ luôn đứng trước lịch vi phạm. */
  function compare(p, q, o) {
    if (p.valid !== q.valid) return p.valid ? -1 : 1;
    if (!p.metrics || !q.metrics) return 0;
    return compareKeys(rank(p, o), rank(q, o));
  }

  // ---------- Mô hình số cho bộ giải ----------

  function model(tasks, o) {
    const r = CT.schedule(tasks), n = tasks.length;
    const index = new Map(tasks.map((t, i) => [t.id, i]));
    const dur = tasks.map((t) => t.duration);
    const wk = tasks.map((t) => (t.duration ? t.workers : 0));
    const preds = tasks.map(() => []), succs = tasks.map(() => []);
    for (const e of r.edges) {
      const a = index.get(e.from), b = index.get(e.to);
      preds[b].push([a, e.w]);
      succs[a].push([b, e.w]);
    }
    const order = r.order.map((id) => index.get(id));
    const position = new Array(n);
    order.forEach((i, k) => (position[i] = k));
    const early = r.rows.map((t) => t.es);
    const H = o.maxDuration;
    // Bắt đầu muộn nhất theo hạn (chỉ xét quan hệ) và đường dài nhất từ đầu công tác tới cuối dự án.
    const late = new Array(n), tail = new Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k];
      let lv = H - dur[i], tv = dur[i];
      for (const [j, w] of succs[i]) {
        lv = Math.min(lv, late[j] - w);
        tv = Math.max(tv, w + tail[j]);
      }
      late[i] = lv;
      tail[i] = tv;
    }
    const totalDur = dur.reduce((s, d) => s + d, 0);
    return {
      tasks, n, dur, wk, preds, succs, order, position, early, late, tail, H,
      L: Math.min(MAX_DAYS, Math.max(H, r.duration) + totalDur + 1),
      maxDur: Math.max(0, ...dur),
      cpm: r.duration,
      direct: tasks.reduce((s, t) => s + t.cost, 0),
      C: o.capacity,
      work: tasks.reduce((s, t) => s + t.duration * t.workers, 0),
    };
  }

  function addLoad(M, load, i, s, sign) {
    const w = M.wk[i] * sign;
    if (!w) return;
    for (let x = s, e = s + M.dur[i]; x < e; x++) load[x] += w;
  }
  function fits(M, load, i, s) {
    const w = M.wk[i], cap = M.C + EPS;
    if (!w) return true;
    for (let x = s, e = s + M.dur[i]; x < e; x++) if (load[x] + w > cap) return false;
    return true;
  }
  function lowBound(M, S, i) {
    let v = 0;
    for (const [j, w] of M.preds[i]) if (S[j] + w > v) v = S[j] + w;
    return v;
  }
  function highBound(M, S, i, limit) {
    let v = limit - M.dur[i];
    for (const [j, w] of M.succs[i]) if (S[j] - w < v) v = S[j] - w;
    return v;
  }
  function makespan(M, S) {
    let T = 0;
    for (let i = 0; i < M.n; i++) if (S[i] + M.dur[i] > T) T = S[i] + M.dur[i];
    return T;
  }
  function loadOf(M, S, size) {
    const load = new Float64Array(size);
    for (let i = 0; i < M.n; i++) addLoad(M, load, i, S[i], 1);
    return load;
  }
  function evaluate(M, S, o, obj) {
    const T = makespan(M, S), load = loadOf(M, S, T + 1);
    let peak = 0, sumSq = 0, mob = 0, prev = 0;
    for (let t = 0; t < T; t++) {
      const v = load[t];
      if (v > peak) peak = v;
      sumSq += v * v;
      if (v > prev) mob += v - prev;
      prev = v;
    }
    const cost = M.direct + o.indirectPerDay * T + o.mobilizationRate * mob;
    return keyOf(obj, Math.max(0, T - M.H), T, peak, sumSq, mob, cost);
  }

  function makeRandom(seed) {
    return function () {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(list, random) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }

  /** Xếp nối tiếp: chọn công tác sẵn sàng có ưu tiên nhỏ nhất, đặt sớm nhất vừa năng lực. */
  function serial(M, priority) {
    const { n, dur, wk, succs } = M, S = new Int32Array(n), load = new Float64Array(M.L + 1);
    const waiting = M.preds.map((p) => p.length), eligible = [];
    for (let i = 0; i < n; i++) if (!waiting[i]) eligible.push(i);
    for (let k = 0; k < n; k++) {
      let pick = 0;
      for (let e = 1; e < eligible.length; e++)
        if (priority[eligible[e]] < priority[eligible[pick]]) pick = e;
      const i = eligible[pick];
      eligible[pick] = eligible[eligible.length - 1];
      eligible.pop();
      let s = lowBound(M, S, i);
      if (wk[i]) {
        for (;;) {
          if (s + dur[i] > M.L) return null;
          let clash = -1;
          for (let x = s + dur[i] - 1; x >= s; x--)
            if (load[x] + wk[i] > M.C + EPS) {
              clash = x;
              break;
            }
          if (clash < 0) break;
          s = clash + 1;
        }
      }
      S[i] = s;
      addLoad(M, load, i, s, 1);
      for (const [j] of succs[i]) if (--waiting[j] === 0) eligible.push(j);
    }
    return S;
  }

  /** Dồn phải rồi dồn trái (forward–backward improvement) để rút thời gian của lịch có giới hạn nguồn lực. */
  function justify(M, S, toRight) {
    const n = M.n, T = makespan(M, S), load = loadOf(M, S, T + 1);
    const ids = Array.from({ length: n }, (_, i) => i);
    if (toRight) ids.sort((a, b) => S[b] + M.dur[b] - (S[a] + M.dur[a]) || S[b] - S[a]);
    else ids.sort((a, b) => S[a] - S[b] || S[a] + M.dur[a] - (S[b] + M.dur[b]));
    for (const i of ids) {
      addLoad(M, load, i, S[i], -1);
      if (toRight) {
        let s = highBound(M, S, i, T);
        while (s > S[i] && !fits(M, load, i, s)) s--;
        S[i] = Math.max(s, S[i]);
      } else {
        let s = lowBound(M, S, i);
        while (s < S[i] && !fits(M, load, i, s)) s++;
        S[i] = Math.min(s, S[i]);
      }
      addLoad(M, load, i, S[i], 1);
    }
  }
  function improveTime(M, S) {
    let T = makespan(M, S);
    for (let k = 0; k < 8; k++) {
      justify(M, S, true);
      justify(M, S, false);
      const next = makespan(M, S);
      if (next >= T) break;
      T = next;
    }
    return S;
  }

  /**
   * Dịch một công tác tới vị trí tốt nhất khi các công tác khác giữ nguyên.
   * Trả về khóa mới nếu cải thiện, ngược lại null. Không bao giờ vượt năng lực hoặc quan hệ;
   * khi lịch đã đúng hạn thì không vượt hạn, khi đang trễ thì không kéo dài thêm.
   */
  function bestMove(M, S, load, i, o, obj, budget) {
    const d = M.dur[i], w = M.wk[i], cur = S[i];
    addLoad(M, load, i, cur, -1);
    let TO = 0;
    for (let j = 0; j < M.n; j++) if (j !== i && S[j] + M.dur[j] > TO) TO = S[j] + M.dur[j];
    let peakO = 0, sumSqO = 0, mobO = 0, prev = 0;
    for (let t = 0; t < TO; t++) {
      const v = load[t];
      if (v > peakO) peakO = v;
      sumSqO += v * v;
      if (v > prev) mobO += v - prev;
      prev = v;
    }
    const limit = Math.max(M.H, TO, cur + d);
    const lo = lowBound(M, S, i), hi = highBound(M, S, i, limit);
    if (hi < lo) {
      addLoad(M, load, i, cur, 1);
      return null;
    }
    const D = (t) => load[t] - (t > 0 ? load[t - 1] : 0);
    const dq = new Int32Array(hi - lo + d + 1);
    let head = 0, tail = 0, wsum = 0;
    for (let x = lo; x < lo + d; x++) {
      wsum += load[x];
      while (tail > head && load[dq[tail - 1]] <= load[x]) tail--;
      dq[tail++] = x;
    }
    let bestS = cur, bestKey = null, curKey = null;
    for (let s = lo; s <= hi; s++) {
      if (s > lo && d > 0) {
        const x = s + d - 1;
        wsum += load[x] - load[s - 1];
        while (tail > head && load[dq[tail - 1]] <= load[x]) tail--;
        dq[tail++] = x;
        while (dq[head] < s) head++;
      }
      const wmax = d > 0 ? load[dq[head]] : 0;
      if (w > 0 && wmax + w > M.C + EPS) continue;
      const T = Math.max(TO, s + d);
      let peak = peakO, sumSq = sumSqO, mob = mobO;
      if (w > 0) {
        peak = Math.max(peakO, wmax + w);
        sumSq = sumSqO + 2 * w * wsum + w * w * d;
        const a = D(s), b = D(s + d);
        mob = mobO + Math.max(0, a + w) - Math.max(0, a) + Math.max(0, b - w) - Math.max(0, b);
      }
      const cost = M.direct + o.indirectPerDay * T + o.mobilizationRate * mob;
      const key = keyOf(obj, Math.max(0, T - M.H), T, peak, sumSq, mob, cost);
      budget.count++;
      if (s === cur) curKey = key;
      if (!bestKey || compareKeys(key, bestKey) < 0) {
        bestKey = key;
        bestS = s;
      }
    }
    // So với chính vị trí hiện tại (cùng cách tính) để tránh dao động do sai số làm tròn.
    if (!curKey || bestS === cur || compareKeys(bestKey, curKey) >= 0) bestS = cur;
    S[i] = bestS;
    addLoad(M, load, i, bestS, 1);
    return bestS !== cur ? bestKey : null;
  }

  function localSearch(M, S, o, obj, budget, random) {
    const size = Math.max(M.H, makespan(M, S)) + M.maxDur + 2;
    const load = loadOf(M, S, size), ids = Array.from({ length: M.n }, (_, i) => i);
    for (let sweep = 0; sweep < 200 && !budget.out(); sweep++) {
      let improved = false;
      shuffle(ids, random);
      for (const i of ids) {
        if (bestMove(M, S, load, i, o, obj, budget)) improved = true;
        if (budget.out()) break;
      }
      if (!improved) break;
    }
    return evaluate(M, S, o, obj);
  }

  function perturb(M, S, random, strength) {
    const T = makespan(M, S), limit = Math.max(M.H, T);
    const load = loadOf(M, S, limit + M.maxDur + 2);
    for (let k = 0; k < strength; k++) {
      const i = Math.floor(random() * M.n);
      addLoad(M, load, i, S[i], -1);
      const lo = lowBound(M, S, i), hi = highBound(M, S, i, limit);
      for (let tries = 0; tries < 8 && hi > lo; tries++) {
        const s = lo + Math.floor(random() * (hi - lo + 1));
        if (fits(M, load, i, s)) {
          S[i] = s;
          break;
        }
      }
      addLoad(M, load, i, S[i], 1);
    }
  }

  /** Lịch tốt nhất với một bộ thời lượng cố định (heuristic). */
  function optimizeFixed(M, o, obj, budget, random, quick, offer) {
    const seeds = [];
    const early = Int32Array.from(M.early);
    if (fits1(M, early)) seeds.push(early);
    const rules = [
      M.late.map((v, i) => v + M.position[i] * 1e-6),
      M.late.map((v, i) => v + M.dur[i] + M.position[i] * 1e-6),
      M.late.map((v, i) => v - M.early[i] + M.position[i] * 1e-6),
      M.position.slice(),
      M.wk.map((w, i) => -w * M.dur[i] + M.position[i] * 1e-6),
    ];
    for (const rule of rules) {
      const S = serial(M, rule);
      if (!S) continue;
      seeds.push(S);
      seeds.push(improveTime(M, S.slice()));
    }
    let best = null;
    const consider = (S, key) => {
      offer(S, key);
      if (!best || compareKeys(key, best.key) < 0) best = { S: S.slice(), key };
    };
    const seen = new Set();
    for (const S of seeds) {
      const sig = S.join(",");
      if (seen.has(sig)) continue;
      seen.add(sig);
      consider(S, localSearch(M, S, o, obj, budget, random));
    }
    if (!best) return null;
    // Tìm kiếm cục bộ lặp: xáo trộn nhẹ → (dồn tiến–lùi) → leo đồi, giữ phương án tốt nhất.
    const maxStall = quick ? 8 : 40 + 3 * M.n;
    let current = best.S.slice(), currentKey = best.key, stall = 0;
    while (!budget.out() && stall < maxStall) {
      let S = current.slice();
      if (obj === "time" && random() < 0.4) {
        const spread = Math.max(1, M.cpm) * 0.35;
        const fresh = serial(M, M.late.map((v) => v + random() * spread));
        if (fresh) S = fresh;
      } else perturb(M, S, random, 1 + Math.floor(random() * Math.max(1, M.n / 6)));
      if (obj === "time" || makespan(M, S) > M.H) improveTime(M, S);
      const key = localSearch(M, S, o, obj, budget, random);
      if (compareKeys(key, best.key) < 0) stall = 0;
      else stall++;
      consider(S, key);
      if (compareKeys(key, currentKey) <= 0) {
        current = S;
        currentKey = key;
      } else {
        current = best.S.slice();
        currentKey = best.key;
      }
    }
    return best;
  }
  function fits1(M, S) {
    const T = makespan(M, S), load = loadOf(M, S, T + 1);
    for (let t = 0; t < T; t++) if (load[t] > M.C + EPS) return false;
    return true;
  }

  /** Nhánh-cận: duyệt mọi mốc bắt đầu nguyên trong [sớm theo quan hệ, muộn theo hạn]. */
  function exact(M, o, obj, budget, incumbent, offer) {
    const { n, order, dur, wk } = M, S = new Int32Array(n), load = new Float64Array(M.H + 2);
    let bestKey = incumbent ? incumbent.slice() : null, nodes = 0, stopped = false;
    const bound = (peak, sumSq, T) => {
      if (obj === "time") return [0, T, peak, sumSq];
      if (obj === "cost") return [0, M.direct + o.indirectPerDay * T + o.mobilizationRate * peak, peak, sumSq];
      return [0, peak, T, sumSq];
    };
    // Cận dưới chưa chắc tệ hơn: dừng khi một thành phần lớn hơn, đi tiếp khi bằng.
    const dominated = (lb) => {
      if (!bestKey) return false;
      for (let k = 0; k < lb.length; k++) {
        const c = cmp1(lb[k], bestKey[k]);
        if (c) return c > 0;
      }
      return false;
    };
    function visit(k, peak, sumSq, Tlb) {
      if (stopped) return;
      if ((++nodes & 15) === 0 && budget.out()) {
        stopped = true;
        return;
      }
      if (k === n) {
        const key = evaluate(M, S, o, obj);
        budget.count++;
        offer(S, key);
        if (!bestKey || compareKeys(key, bestKey) < 0) bestKey = key;
        return;
      }
      const i = order[k], d = dur[i], w = wk[i], lo = lowBound(M, S, i), hi = M.late[i];
      const choices = [];
      for (let s = lo; s <= hi; s++) {
        let wmax = 0, wsum = 0;
        for (let x = s; x < s + d; x++) {
          if (load[x] > wmax) wmax = load[x];
          wsum += load[x];
        }
        if (w > 0 && wmax + w > M.C + EPS) continue;
        const np = w > 0 ? Math.max(peak, wmax + w) : peak;
        const nsq = sumSq + (w > 0 ? 2 * w * wsum + w * w * d : 0);
        const nT = Math.max(Tlb, s + M.tail[i]);
        if (dominated(bound(np, nsq, nT))) continue;
        choices.push([s, np, nsq, nT]);
      }
      if (obj === "workforce") choices.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
      for (const [s, np, nsq, nT] of choices) {
        if (dominated(bound(np, nsq, nT))) continue;
        S[i] = s;
        addLoad(M, load, i, s, 1);
        visit(k + 1, np, nsq, nT);
        addLoad(M, load, i, s, -1);
        if (stopped) return;
      }
    }
    if (M.late.every((v, i) => v >= M.early[i])) visit(0, 0, 0, M.cpm);
    return { bestKey, nodes, stopped };
  }

  function* durationVectors(original, crashable) {
    const base = Object.fromEntries(original.map((t) => [t.id, t.duration]));
    function* walk(k, current) {
      if (k === crashable.length) {
        yield { ...current };
        return;
      }
      const t = crashable[k];
      for (let d = t.duration; d >= durationFloor(t); d--) {
        current[t.id] = d;
        yield* walk(k + 1, current);
      }
      current[t.id] = t.duration;
    }
    yield* walk(0, base);
  }

  /** Giữ tối đa 6 phương án có chỉ tiêu khác nhau, xếp theo mục tiêu. */
  function makePool(original, o, ids) {
    const items = [];
    return {
      offer(key, durations, S) {
        const sig = key.map((v) => Math.round(v * 1e6) / 1e6).join("|");
        if (items.some((x) => x.sig === sig)) return;
        if (items.length >= 6 && compareKeys(key, items[items.length - 1].key) >= 0) return;
        items.push({
          key,
          sig,
          durations: { ...durations },
          starts: Object.fromEntries(ids.map((id, i) => [id, S[i]])),
        });
        items.sort((a, b) => compareKeys(a.key, b.key));
        if (items.length > 6) items.pop();
      },
      plans() {
        return items.map((x) => candidate(original, x.durations, x.starts, o));
      },
    };
  }

  /** Lịch theo mốc đã bố trí; dự trữ tính lùi có xét năng lực khi có giới hạn. */
  function result(tasks, plan, capacity = Infinity) {
    const base = CT.schedule(tasks), n = tasks.length;
    const index = new Map(tasks.map((t, i) => [t.id, i]));
    const S = tasks.map((t) => plan.starts[t.id]), dur = tasks.map((t) => t.duration);
    const wk = tasks.map((t) => (t.duration ? t.workers : 0));
    const duration = Math.max(0, ...tasks.map((t, i) => S[i] + dur[i]));
    const succs = tasks.map(() => []), preds = tasks.map(() => []);
    for (const e of base.edges) {
      const a = index.get(e.from), b = index.get(e.to);
      succs[a].push([b, e.w]);
      preds[b].push([a, e.w]);
    }
    const limited = Number.isFinite(capacity);
    const load = new Float64Array(duration + 1);
    for (let i = 0; i < n; i++) for (let x = S[i]; x < S[i] + dur[i]; x++) load[x] += wk[i];
    const fitsAt = (i, s) => {
      if (!limited || !wk[i]) return true;
      for (let x = s; x < s + dur[i]; x++) if (load[x] + wk[i] > capacity + EPS) return false;
      return true;
    };
    const move = (i, from, to) => {
      for (let x = from; x < from + dur[i]; x++) load[x] -= wk[i];
      for (let x = to; x < to + dur[i]; x++) load[x] += wk[i];
    };
    // Dự trữ riêng: lùi được bao nhiêu ngày mà không đẩy công tác sau và không vượt năng lực.
    const ff = tasks.map((t, i) => {
      let hi = duration - dur[i];
      for (const [j, w] of succs[i]) hi = Math.min(hi, S[j] - w);
      if (!limited) return hi - S[i];
      move(i, S[i], -1e9);
      let s = S[i];
      while (s < hi && fitsAt(i, s + 1)) s++;
      move(i, -1e9, S[i]);
      return s - S[i];
    });
    // Lịch muộn: xét công tác sau khi mọi công tác sau nó đã xét, kết thúc muộn trước.
    const late = S.slice(), pending = succs.map((x) => x.length), ready = [];
    for (let i = 0; i < n; i++) if (!pending[i]) ready.push(i);
    while (ready.length) {
      let pick = 0;
      for (let k = 1; k < ready.length; k++) {
        const a = ready[k], b = ready[pick];
        if (S[a] + dur[a] > S[b] + dur[b] || (S[a] + dur[a] === S[b] + dur[b] && S[a] > S[b])) pick = k;
      }
      const i = ready.splice(pick, 1)[0];
      let hi = duration - dur[i];
      for (const [j, w] of succs[i]) hi = Math.min(hi, late[j] - w);
      if (limited && wk[i]) {
        for (let x = S[i]; x < S[i] + dur[i]; x++) load[x] -= wk[i];
        let s = hi;
        while (s > S[i] && !fitsAt(i, s)) s--;
        late[i] = Math.max(s, S[i]);
        for (let x = late[i]; x < late[i] + dur[i]; x++) load[x] += wk[i];
      } else late[i] = Math.max(hi, S[i]);
      for (const [j] of preds[i]) if (--pending[j] === 0) ready.push(j);
    }
    const rows = base.rows.map((t) => {
      const i = index.get(t.id);
      return {
        ...t,
        cpmEs: t.es, cpmEf: t.ef, cpmLs: t.ls, cpmLf: t.lf, cpmTf: t.tf, cpmFf: t.ff, cpmCritical: t.critical,
        es: S[i], ef: S[i] + dur[i], ls: late[i], lf: late[i] + dur[i],
        tf: late[i] - S[i], ff: ff[i], critical: late[i] === S[i],
      };
    });
    const map = new Map(rows.map((t) => [t.id, t]));
    const edges = base.edges.map((e) => ({
      ...e,
      slack: plan.starts[e.to] - plan.starts[e.from] - e.w,
      critical:
        map.get(e.from).critical && map.get(e.to).critical &&
        plan.starts[e.to] === plan.starts[e.from] + e.w,
    }));
    return {
      ...base, rows, edges, duration,
      cpmDuration: base.duration, cpmCritical: base.critical,
      critical: rows.filter((t) => t.critical).map((t) => t.id),
      placement: true, resourceAware: limited,
    };
  }

  function active(project) {
    const selected = project.planning?.selected;
    if (!selected || selected.fingerprint !== fingerprint(project.tasks)) return CT.schedule(project.tasks);
    try {
      const tasks = effective(project.tasks, selected.durations);
      const o = options(project.planning, project), check = inspect(tasks, selected.starts, o);
      if (check.issues.some((x) => x.kind === "relation" || x.kind === "start")) return CT.schedule(project.tasks);
      return result(tasks, selected, o.capacity);
    } catch {
      return CT.schedule(project.tasks);
    }
  }

  function validate(project) {
    if (!project.planning) return;
    const p = project.planning;
    options(p, project);
    if (p.selected) {
      if (
        typeof p.selected.fingerprint !== "string" ||
        p.selected.fingerprint.length > 150000 ||
        !p.selected.starts ||
        !p.selected.durations ||
        typeof p.selected.starts !== "object" ||
        typeof p.selected.durations !== "object"
      )
        throw Error("Phương án đã lưu không hợp lệ.");
      if (p.selected.fingerprint === fingerprint(project.tasks)) {
        const check = candidate(project.tasks, p.selected.durations, p.selected.starts, options(p, project));
        if (check.issues.some((x) => x.kind === "relation" || x.kind === "start"))
          throw Error("Phương án đã lưu vi phạm quan hệ hoặc mốc thời gian.");
      }
    }
  }

  /** Cận dưới lý thuyết để người dùng thấy khoảng cách tới tối ưu. */
  function lowerBounds(original, o) {
    const floors = effective(original, o.allowCrash ? Object.fromEntries(original.map((t) => [t.id, durationFloor(t)])) : {});
    const work = original.reduce((s, t) => s + t.duration * t.workers, 0);
    const integral = original.every((t) => Number.isInteger(t.workers));
    const maxCrew = Math.max(0, ...original.filter((t) => t.duration > 0).map((t) => t.workers));
    const spread = o.maxDuration > 0 ? work / o.maxDuration : 0;
    return {
      peak: Math.max(maxCrew, integral ? Math.ceil(spread - 1e-9) : spread),
      duration: Math.max(CT.schedule(floors).duration, o.capacity > 0 ? Math.ceil(work / o.capacity - 1e-9) : 0),
    };
  }

  function solve(project, input = {}, manualStarts = {}, limits = {}) {
    const original = project.tasks, o = options(input, project);
    if (!original.length) throw Error("Nhập ít nhất một công tác trước khi xếp lịch.");
    const base = CT.schedule(original);
    const basicStarts = Object.fromEntries(base.rows.map((t) => [t.id, t.es]));
    const basic = candidate(original, {}, basicStarts, o);
    if (o.strategy !== "algorithm") {
      const plan = o.strategy === "basic" ? basic : candidate(original, {}, manualStarts, o);
      return {
        options: o, basic, best: plan, alternatives: [plan], complete: true,
        method: o.strategy, evaluated: 1, objective: objective(o),
        scope: "Thời lượng giữ nguyên; kiểm tra toàn bộ quan hệ.",
      };
    }
    if (o.maxDuration > 3000 || base.duration > 3000)
      throw Error("Bộ tối ưu hỗ trợ phạm vi tối đa 3.000 ngày; dùng xếp cơ bản hoặc xếp tay cho tiến độ dài hơn.");
    const obj = objective(o), started = Date.now(), maxMs = limits.maxMs ?? 6000;
    const budget = {
      deadline: started + maxMs,
      max: limits.maxEvaluations ?? 5e7,
      count: 0,
      out() {
        return this.count >= this.max || Date.now() > this.deadline;
      },
    };
    const bounds = lowerBounds(original, o);
    const tooLarge = original.some((t) => t.workers > o.capacity && t.duration > 0);
    if (tooLarge)
      return {
        options: o, basic, best: null, alternatives: [], complete: true, method: "infeasible",
        evaluated: 0, objective: obj, bounds,
        reason: "Có công tác cần nhiều người hơn năng lực. Việc dịch ngày không thể làm công tác đó khả thi.",
      };
    const ids = original.map((t) => t.id), random = makeRandom(20261019);
    const pool = makePool(original, o, ids);
    if (basic.valid) pool.offer(rank(basic, o), {}, Int32Array.from(ids.map((id) => basicStarts[id])));
    const crashable = o.allowCrash ? original.filter((t) => t.duration > durationFloor(t)) : [];
    const baseDurations = Object.fromEntries(original.map((t) => [t.id, t.duration]));
    const runFixed = (durations, quick) => {
      const tasks = effective(original, durations);
      if (tasks.some((t) => t.duration > 0 && t.workers > o.capacity)) return null;
      const M = model(tasks, o);
      const best = optimizeFixed(M, o, obj, budget, random, quick, (S, key) => pool.offer(key, durations, S));
      return best && { ...best, durations };
    };

    // 1) Lời giải nhanh làm cận trên cho nhánh-cận.
    let incumbent = runFixed(baseDurations, true);
    // 2) Bài nhỏ: duyệt đầy đủ, có thể kèm mọi tổ hợp thời lượng rút ngắn.
    let complete = false, nodes = 0;
    const combos = crashable.reduce((s, t) => s * (t.duration - durationFloor(t) + 1), 1);
    // Ước lượng miền tìm kiếm (tích số mốc bắt đầu có thể); quá lớn thì để heuristic xử lý.
    const baseModel = model(original, o);
    const logSpace = baseModel.late.reduce((s, v, i) => s + Math.log(Math.max(1, v - baseModel.early[i] + 1)), Math.log(combos));
    if (original.length <= 10 && combos <= 256 && logSpace <= Math.log(2e7) && !budget.out()) {
      const exactBudget = {
        deadline: Math.min(budget.deadline, started + maxMs * 0.6),
        out() {
          return budget.count >= budget.max || Date.now() > this.deadline;
        },
        get count() {
          return budget.count;
        },
        set count(v) {
          budget.count = v;
        },
      };
      let bestKey = incumbent?.key || null, finished = true;
      for (const durations of durationVectors(original, crashable)) {
        const tasks = effective(original, durations);
        if (tasks.some((t) => t.duration > 0 && t.workers > o.capacity)) continue;
        const M = model(tasks, o);
        const r = exact(M, o, obj, exactBudget, bestKey, (S, key) => pool.offer(key, durations, S));
        nodes += r.nodes;
        if (r.bestKey && (!bestKey || compareKeys(r.bestKey, bestKey) < 0)) bestKey = r.bestKey;
        if (r.stopped) {
          finished = false;
          break;
        }
      }
      complete = finished;
    }
    // 3) Bài lớn hoặc chưa duyệt xong: cải thiện thêm và thử rút ngắn từng ngày.
    if (!complete) {
      const deeper = runFixed(baseDurations, false);
      if (deeper && (!incumbent || compareKeys(deeper.key, incumbent.key) < 0)) incumbent = deeper;
      let current = incumbent;
      while (current && crashable.length && !budget.out()) {
        let next = null;
        const crashNext = crashable
          .filter((t) => current.durations[t.id] > durationFloor(t))
          .sort((a, b) => a.crashSlope - b.crashSlope)
          .slice(0, 12);
        for (const t of crashNext) {
          const trial = runFixed({ ...current.durations, [t.id]: current.durations[t.id] - 1 }, true);
          if (trial && compareKeys(trial.key, (next || current).key) < 0) next = trial;
          if (budget.out()) break;
        }
        if (!next) break;
        current = next;
      }
    }
    const all = pool.plans(), plans = all.filter((p) => p.valid);
    const best = plans[0] || null;
    // Không kịp hạn: vẫn trả lịch ngắn nhất tìm được (chỉ vi phạm hạn) để người dùng thấy cần lùi bao nhiêu.
    const nearest = best ? null : all.find((p) => p.metrics && p.issues.every((x) => x.kind === "deadline")) || null;
    let reason = "";
    if (!best) {
      const deadlineGap = bounds.duration - o.maxDuration;
      reason =
        deadlineGap > 0
          ? "Hạn " + o.maxDuration + " ngày ngắn hơn cận dưới " + bounds.duration + " ngày (đường găng hoặc tổng công ÷ năng lực). Tăng hạn, năng lực hoặc cho phép rút ngắn."
          : complete
            ? "Đã duyệt đầy đủ: không có lịch nào thỏa đồng thời năng lực và hạn hoàn thành."
            : "Chưa tìm được lịch thỏa năng lực và hạn trong thời gian cho phép. Điều này chưa chứng minh bài toán vô nghiệm.";
    }
    return {
      options: o, basic, best, nearest, alternatives: plans.slice(0, 5), complete,
      method: complete ? "exhaustive" : "heuristic",
      evaluated: budget.count, nodes, elapsedMs: Date.now() - started,
      objective: obj, bounds, reason,
    };
  }

  return {
    defaults, options, objective, fingerprint, effective, profile, metrics, inspect, candidate,
    rank, score: rank, compare, compareKeys, result, active, validate, solve, lowerBounds,
  };
});
