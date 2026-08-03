/**
 * SHOPLINE 訂單/折扣碼 + Meta 廣告成效代理 Worker
 * ------------------------------------------------------------
 * 用途:
 *   1. 幫「品牌成效分析.html」工具安全地呼叫 SHOPLINE Open API
 *   2. 幫同一個工具安全地呼叫 Meta Graph API(抓廣告成效),支援多個廣告帳號(品牌)
 *   權杖都只存在這個 Worker 裡,前端網頁完全看不到、碰不到。
 *
 * 部署方式請參考另一份教學文件。
 *
 * 需要在 Cloudflare Workers 後台設定以下環境變數:
 *   - SHOPLINE_TOKEN      (Secret,加密) SHOPLINE 後台產生的 access_token
 *   - SHOPLINE_USER_AGENT (一般變數)    你的商店 handle,例如 "queenpunch439"
 *   - META_TOKEN          (Secret,加密) Meta 廣告的長期存取權杖(假設同一組權杖能存取下面兩個廣告帳號)
 *   - PROXY_SECRET        (Secret,加密) 只有你的網頁工具知道的密碼,擋掉隨機亂試網址的人
 *     (注意:這只能擋「隨便亂猜網址」的人,擋不住會打開瀏覽器開發工具看網路請求的人,
 *      因為前端網頁的程式碼本來就是公開的。真正要防蓄意的人需要做登入系統,是完全不同規模的工程。)
 *
 * 允許查詢的廣告帳號 ID,寫死在下面 ALLOWED_META_ACCOUNTS 這個常數裡——
 * 前端只能從這個白名單裡選,不能任意傳其他帳號 ID 進來查詢,確保只有這兩個品牌的資料能被抓取。
 * 之後如果要新增/移除品牌,直接改這個常數就好。
 *
 * 呼叫方式(從瀏覽器端的網頁工具呼叫這個 Worker,都要帶 Header:X-Proxy-Auth: <PROXY_SECRET 的值>):
 *   GET /api/orders?since=2026-06-29&until=2026-07-05                              (Shopline 訂單/折扣碼)
 *   GET /api/meta/timezone?accountId=436280797192761                                (Meta 廣告帳號的時區)
 *   GET /api/meta/insights?accountId=436280797192761&since=2026-06-29&until=2026-07-05&relax=true  (Meta 廣告成效)
 *   since / until 請用「台灣時間的日期」(YYYY-MM-DD)。
 *
 * ------------------------------------------------------------
 * 2026-07-30 修正:高流量帳號(例如 H&J 一頁業績)整月查詢常常失敗,錯誤代碼 1/99。
 * 根本原因(程式碼裡舊註解已經點出來過):廣告數量多的月份,「抓廣告清單/成效資料」這段
 * 逼近甚至超過合理的執行時間,很可能因此在 Meta 那邊或執行環境被中斷。
 * 這次改動只針對這個情境做兩件事,不影響其他品牌、不影響週報表(relax=true)的既有行為:
 *   (a) 整月查詢(relax=false)時,「廣告清單/縮圖/UTM」這段只對「花費有機會達標」的廣告
 *       抓取細節,不用對每一支花費很低、之後反正會被篩掉的廣告都白跑一次,大幅減少對
 *       Meta 打的請求次數。週報表(relax=true)因為需要知道每支廣告是否正在投放中,才能
 *       決定要不要放寬納入,所以維持原本「全部都抓」的做法不變。
 *   (b) 查詢區間如果超過 20 天(代表是月報表這種大範圍查詢),自動切成兩段各自去問 Meta
 *       insights,再把結果合併——單次請求範圍變小,比較不容易在 Meta 那邊逼近逾時。
 * ------------------------------------------------------------
 */

const SHOPLINE_BASE = "https://open.shopline.io/v1";
const PER_PAGE = 50;
// SHOPLINE 限制每秒 20 次請求,這裡刻意抓保守一點的間隔,
// 避免跟你之後如果同時開好幾個分頁/裝置一起用時撞到限制。
const MIN_REQUEST_GAP_MS = 150;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Auth",
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(origin),
    },
  });
}

// 把 "YYYY-MM-DD"(視為台灣時間 00:00:00 或 23:59:59)轉成 SHOPLINE 要求的 UTC 字串
// 台灣時間 = UTC+8,所以台灣時間減 8 小時就是 UTC 時間。
// 這裡刻意不用 split("-") 硬切,因為瀏覽器/輸入法有時會把「-」自動換成其他符號(例如全形破折號),
// 改用正則表達式只抓「數字」本身,不管中間用什麼符號分隔,都能正確解析,比較不容易出錯。
function parseDateParts(dateStr) {
  const match = String(dateStr || "").match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function taiwanDateToUtcString(dateStr, endOfDay) {
  const parts = parseDateParts(dateStr);
  if (!parts) {
    throw new Error(`日期格式無法解析:收到的原始值是 "${dateStr}",請確認格式為 YYYY-MM-DD。`);
  }
  const { y, m, d } = parts;
  // 用 UTC 建構一個「代表台灣時間那個時刻」的 timestamp,再減 8 小時取得真正的 UTC 時刻
  const hh = endOfDay ? 23 : 0;
  const mm = endOfDay ? 59 : 0;
  const ss = endOfDay ? 59 : 0;
  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  const realUtcMs = asIfUtc - 8 * 3600 * 1000;
  const dt = new Date(realUtcMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(
    dt.getUTCHours()
  )}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 呼叫 SHOPLINE API,內建簡單的 429 重試機制(遇到限流就等一下再試,最多重試 3 次)
async function callShopline(path, params, env) {
  const url = new URL(SHOPLINE_BASE + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  let attempt = 0;
  while (attempt < 4) {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.SHOPLINE_TOKEN}`,
        "User-Agent": env.SHOPLINE_USER_AGENT || "shopline-proxy-worker",
      },
    });

    if (res.status === 429) {
      attempt++;
      await sleep(500 * attempt);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`SHOPLINE API 回應錯誤 (status ${res.status}): ${text.slice(0, 300)}`);
    }

    return res.json();
  }
  throw new Error("SHOPLINE API 持續回應 429(超過流量限制),請稍後再試一次。");
}

function centsToDollars(moneyObj) {
  if (!moneyObj) return 0;
  if (typeof moneyObj.dollars === "number") return moneyObj.dollars;
  if (typeof moneyObj.cents === "number") return moneyObj.cents / 100;
  return 0;
}

// 把 SHOPLINE 原始訂單物件,整理成我們工具要用的精簡格式
function normalizeOrder(raw) {
  const codes = [];
  let discountAmount = 0;
  (raw.promotion_items || []).forEach((pi) => {
    discountAmount += centsToDollars(pi.discounted_amount);
    const promoCodes = (pi.promotion && pi.promotion.codes) || [];
    promoCodes.forEach((c) => {
      if (c && !codes.includes(c)) codes.push(c);
    });
  });
  // order_discount 是訂單層級的折扣總額(有時候比逐個 promotion_item 加總更準,兩者都留著方便對照)
  const orderDiscount = centsToDollars(raw.order_discount);

  return {
    orderId: raw.id,
    orderNumber: raw.order_number,
    status: raw.status,
    paymentStatus: raw.order_payment ? raw.order_payment.status : null,
    amount: centsToDollars(raw.total),
    subtotal: centsToDollars(raw.subtotal),
    discountAmount: discountAmount || orderDiscount,
    discountCodes: codes,
    createdAt: raw.created_at,
    utm: raw.utm_data || {},
  };
}

function buildDiscountSummary(orders) {
  const byCode = {};
  orders.forEach((o) => {
    if (!o.discountCodes || !o.discountCodes.length) return;
    // 一張訂單可能同時用了多個折扣碼(multiple_code),每個都各自累計一次使用次數,
    // 但金額不重複灌水:折扣金額/營業額只在「第一個」代表碼上算一次,避免同一筆訂單的錢被算兩次。
    o.discountCodes.forEach((code, idx) => {
      if (!byCode[code]) {
        byCode[code] = { code, usageCount: 0, grossRevenue: 0, discountAmount: 0, netRevenue: 0 };
      }
      byCode[code].usageCount += 1;
      if (idx === 0) {
        byCode[code].grossRevenue += o.amount + o.discountAmount;
        byCode[code].discountAmount += o.discountAmount;
        byCode[code].netRevenue += o.amount;
      }
    });
  });
  return Object.values(byCode).sort((a, b) => b.netRevenue - a.netRevenue);
}

async function handleOrders(url, env, origin) {
  const since = url.searchParams.get("since"); // YYYY-MM-DD,台灣時間
  const until = url.searchParams.get("until");
  if (!since || !until) {
    return jsonResponse({ error: "請帶入 since 與 until 參數,格式為 YYYY-MM-DD(台灣時間日期)。" }, 400, origin);
  }

  const createdAfter = taiwanDateToUtcString(since, false);
  const createdBefore = taiwanDateToUtcString(until, true);

  let page = 1;
  let totalPages = 1;
  const allOrders = [];
  let fetchedPages = 0;

  do {
    const data = await callShopline(
      "/orders",
      {
        created_after: createdAfter,
        created_before: createdBefore,
        per_page: PER_PAGE,
        page,
        sort_by: "asc",
      },
      env
    );

    (data.items || []).forEach((raw) => {
      allOrders.push(normalizeOrder(raw));
    });

    totalPages = (data.pagination && data.pagination.total_pages) || 1;
    fetchedPages++;
    page++;

    if (page <= totalPages) await sleep(MIN_REQUEST_GAP_MS);
  } while (page <= totalPages);

  const discountSummary = buildDiscountSummary(allOrders);

  return jsonResponse(
    {
      orders: allOrders,
      discountSummary,
      meta: {
        totalOrders: allOrders.length,
        since,
        until,
        createdAfterUtc: createdAfter,
        createdBeforeUtc: createdBefore,
        fetchedPages,
      },
    },
    200,
    origin
  );
}

// ================================================================
// Meta 廣告成效代理(邏輯完整比照原本前端 JS 的做法搬過來,盡量不改動,降低出錯風險)
// ================================================================

const META_GRAPH_BASE = "https://graph.facebook.com/v19.0";
const MIN_FETCH_SPEND = 500;
const MIN_META_API_GAP_MS = 1200; // 任兩次 Meta Graph API 請求之間的最小間隔(毫秒)

// 允許查詢的廣告帳號(品牌)白名單,寫死在程式碼裡,前端不能傳其他 ID 進來查詢。
// 之後新增/移除品牌,直接改這裡就好。
// 原本這個白名單是寫死在程式碼裡的常數,新增品牌就要回來改這裡、重新貼一次 Quick Edit。
// 改成優先從 KV 讀(env.REPORT_KV,跟報表網站/排程 Worker 共用同一個 report-kv 命名空間)——
// 這樣以後新增品牌只需要透過「快速新增品牌」工具寫入 KV,不用再碰這支檔案的原始碼。
// 這個常數保留當作「KV 還沒綁定,或讀取失敗時」的保底名單,不會因為 KV 一時連不上就整個罷工
// (需要 Hanna 自己去 Cloudflare Dashboard → shopline-proxy → 設定 → 變數與機密 → KV 命名空間繫結,
// 加一個 binding 名稱 REPORT_KV、指向 report-kv 這個命名空間,id: d283e1d9fa8f4ec1b1a64f2818649cb0,
// 這是一次性設定,不是每次新增品牌都要做)。
const FALLBACK_ALLOWED_META_ACCOUNTS = {
  "436280797192761": "H&J官網業績",
  "2157995930925784": "H&J 一頁業績",
  "1818692121940743": "Halo-Mavis國際連線(光速代操)",
  "2345685238995965": "J.GAO",
  "262142297928838": "KP記憶香氛",
  "187260575688386": "宥凱(光速代操)",
};
const META_ACCOUNTS_KV_KEY = "meta-accounts-whitelist";

async function getAllowedMetaAccounts(env) {
  if (!env.REPORT_KV) return FALLBACK_ALLOWED_META_ACCOUNTS;
  try {
    const raw = await env.REPORT_KV.get(META_ACCOUNTS_KV_KEY);
    if (!raw) return FALLBACK_ALLOWED_META_ACCOUNTS;
    const parsed = JSON.parse(raw);
    return parsed && Object.keys(parsed).length ? parsed : FALLBACK_ALLOWED_META_ACCOUNTS;
  } catch {
    return FALLBACK_ALLOWED_META_ACCOUNTS;
  }
}

// 注意:這幾個 action_type 在 Meta 回傳的同一筆資料裡經常是「同一筆購買的不同算法」而不是彼此獨立的訂單,
// 同一列資料只採用「優先順序最前面、且有出現」的那一種購買類型,不同類型之間不相加。
const PURCHASE_ACTION_PRIORITY = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
  "onsite_web_app_purchase",
];

function pickPurchaseValue(list) {
  if (!list || !list.length) return 0;
  for (const type of PURCHASE_ACTION_PRIORITY) {
    const match = list.find((a) => a.action_type === type);
    if (match) return parseFloat(match.value) || 0;
  }
  return 0;
}

// 從網址參數(url_tags / UTM 字串)裡取出「=」後面的那串值,用來判斷是不是同一個素材。
function extractUtmValue(raw) {
  if (!raw) return "";
  const first = raw.split("&")[0] || raw;
  const eqIdx = first.indexOf("=");
  const value = eqIdx >= 0 ? first.slice(eqIdx + 1) : first;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* 保留原始值 */
  }
  return decoded.trim();
}

// 節流用的小物件,每個request handler自己建一個,不會跟其他人的請求互相干擾。
function newThrottleState() {
  return { lastCallAt: 0 };
}

async function throttledMetaFetch(state, url, context) {
  const now = Date.now();
  const wait = state.lastCallAt + MIN_META_API_GAP_MS - now;
  if (wait > 0) await sleep(wait);
  state.lastCallAt = Date.now();
  try {
    return await fetch(url);
  } catch (e) {
    throw new Error(`${context || "呼叫 Meta API"}時網路請求失敗:${e.message}`);
  }
}

async function parseMetaResponse(res, context) {
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${context}回傳的內容無法解析(可能是網路中斷或 Meta 伺服器異常)。`);
  }
  if (!res.ok || json.error) {
    const code = json.error && json.error.code;
    const sub = json.error && json.error.error_subcode;
    const msg = (json.error && json.error.message) || `HTTP ${res.status}`;
    const err = new Error(`${context}失敗(錯誤代碼 ${code || res.status}${sub ? "/" + sub : ""}):${msg}`);
    err.code = code;
    err.subcode = sub;
    throw err;
  }
  return json;
}

// 統一包裝「打 API + 解析回應」,遇到 Meta 那邊回傳的暫時性錯誤時,自動等一下重試。
async function fetchGraphApi(state, url, context, retriesLeft = 2) {
  const res = await throttledMetaFetch(state, url, context);
  try {
    return await parseMetaResponse(res, context);
  } catch (e) {
    if ((e.code === 1 || e.code === 2) && retriesLeft > 0) {
      const waitMs = retriesLeft === 2 ? 3000 : 6000;
      await sleep(waitMs);
      return fetchGraphApi(state, url, context, retriesLeft - 1);
    }
    throw e;
  }
}

// 查廣告帳號自己的時區(跟 UTC 差幾小時),讓前端算「上週一~週日」的日期範圍時能對齊 Meta 後台。
async function fetchAccountUtcOffset(state, token, accountId) {
  try {
    const json = await fetchGraphApi(
      state,
      `${META_GRAPH_BASE}/act_${accountId}?fields=timezone_offset_hours_utc&access_token=${encodeURIComponent(token)}`,
      "讀取帳號時區"
    );
    return typeof json.timezone_offset_hours_utc === "number" ? json.timezone_offset_hours_utc : null;
  } catch {
    return null;
  }
}

function metaApiErrorHint(e) {
  const msg = (e && e.message) || "";
  if (e && (e.code === 1 || e.code === 2)) {
    return (
      "。這不是權杖或帳號 ID 設定錯誤——Meta 官方把這種錯誤歸類為「暫時性問題,建議直接重試」," +
      "常見原因是短時間內對同一個廣告帳號打太多次 API,系統已經自動重試過,如果還是失敗,等 1~2 分鐘再試一次通常就會恢復。"
    );
  }
  if (/too many calls/i.test(msg) || /80004/.test(msg) || /error_subcode 2446079/i.test(msg)) {
    return "。這是 Meta 廣告帳號的呼叫頻率限制,不是設定錯誤——通常等 5~15 分鐘再試一次就會恢復。";
  }
  return "。請確認權杖沒過期、廣告帳號 ID 正確,且已授權 ads_read 權限。";
}

// 抓「單一段」時間範圍的 per-ad insights 原始列(不分組、不查廣告細節),供下面依需要切段呼叫。
// context帶上實際的since~until,萬一失敗,錯誤訊息能直接看出是切段後的哪一小段(哪一週)出問題,
// 不用再靠猜的——之前的版本錯誤訊息都寫「讀取成效資料」,看不出是第幾段失敗。
async function fetchInsightsRowsForRange(state, token, accountId, since, until) {
  const encToken = encodeURIComponent(token);
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  let insightsUrl =
    `${META_GRAPH_BASE}/act_${accountId}/insights?level=ad&use_account_attribution_setting=true` +
    `&fields=ad_id,ad_name,spend,actions,action_values&time_range=${timeRange}&limit=500&access_token=${encToken}`;
  let rows = [];
  let page = 0;
  while (insightsUrl && page < 20) {
    const json = await fetchGraphApi(state, insightsUrl, `讀取成效資料(${since}~${until},第${page + 1}頁)`);
    rows = rows.concat(json.data || []);
    insightsUrl = json.paging && json.paging.next ? json.paging.next : null;
    page++;
  }
  return rows;
}

// 2026-07-30 二次修正:原本以為問題是「單次查詢範圍太大、太複雜、逼近逾時」,所以切成多段各自查詢。
// 但後來確認這個Meta App目前是Dev Tier,額度上限是「每個廣告帳號每小時300次請求」——這是用
// 「總呼叫次數」算的,不是用「每次請求的複雜度」算的。切成越多段,總呼叫次數反而越多,在這種
// 按次數計算的硬上限下,方向是錯的:應該盡量減少總呼叫次數,不是減少單次複雜度。改回單一次查詢,
// 讓 Meta 自己的分頁機制(paging.next)處理大資料量——分頁呼叫一樣算次數,但至少不會平白多出
// 「切成8段、每段都要重新查一次貨幣/從頭來」這種額外開銷。這個函式保留,但目前固定回傳單一段,
// 之後如果 Dev Tier 額度有調整,只要改這裡就能重新啟用切段邏輯,不用大動其他程式碼。
function splitDateRangeIfLarge(since, until) {
  return [{ since, until }];
}

// 抓某段期間(since ~ until)的廣告成效,邏輯跟原本前端版本一致:
// 0) 帳號幣別 1) 逐廣告成效(分頁,範圍太大時自動切成兩段合併) 2) 縮圖/UTM/投放狀態/所屬活動
//    (relax=false 時只對「花費有機會達標」的廣告抓細節,relax=true 維持全部都抓)
// 3) 未篩選總計 4) 依 UTM 分組彙總。
async function fetchInsightsForRange(state, token, accountId, since, until, relaxThreshold) {
  const encToken = encodeURIComponent(token);

  // 0) account currency
  let currency = "TWD";
  try {
    const curJson = await fetchGraphApi(
      state,
      `${META_GRAPH_BASE}/act_${accountId}?fields=currency&access_token=${encToken}`,
      "讀取帳號幣別"
    );
    if (curJson.currency) currency = curJson.currency;
  } catch {
    /* fall back to TWD */
  }

  // 1) per-ad performance for the range——範圍太大(月報表等級)時自動切成兩段各自查詢再合併,
  // 降低單次 Meta insights 查詢的複雜度,減少逼近逾時/複雜度上限的機會。
  const ranges = splitDateRangeIfLarge(since, until);
  let rawRows = [];
  for (const r of ranges) {
    const part = await fetchInsightsRowsForRange(state, token, accountId, r.since, r.until);
    rawRows = rawRows.concat(part);
  }

  // 切成兩段查詢時,同一支廣告會分別出現在兩段各自的結果裡(各自只帶那一半時間範圍的花費/成果),
  // 這裡依 ad_id 把同一支廣告的兩段資料加總合併成一列,讓 row.spend 還原成「整段期間的總花費」——
  // 不合併的話,後面「花費是否達門檻」的判斷會用單段(半個月)的花費去跟門檻比,可能誤判排除掉
  // 那些花費平均分散在兩段、單段各自都不到門檻但合計其實有達標的廣告,是資料正確性問題,不能不修。
  // 只有 1 段(週報表等短範圍,沒有真的切段)時,這裡等於原封不動,不影響既有行為。
  let rows;
  if (ranges.length <= 1) {
    rows = rawRows;
  } else {
    const mergedByAdId = {};
    rawRows.forEach((r) => {
      const key = r.ad_id || `__no_id_${Math.random()}`;
      if (!mergedByAdId[key]) {
        mergedByAdId[key] = { ad_id: r.ad_id, ad_name: r.ad_name, spend: 0, actions: [], action_values: [] };
      }
      const m = mergedByAdId[key];
      m.spend = (parseFloat(m.spend) || 0) + (parseFloat(r.spend) || 0);
      // actions / action_values 是「依 action_type 分類的陣列」,合併時同 action_type 的 value 相加,
      // 不同 action_type 各自保留——跟 Meta 原本單次查詢一段完整範圍時的資料形狀完全一致。
      ["actions", "action_values"].forEach((field) => {
        (r[field] || []).forEach((entry) => {
          const existing = m[field].find((e) => e.action_type === entry.action_type);
          if (existing) {
            existing.value = String((parseFloat(existing.value) || 0) + (parseFloat(entry.value) || 0));
          } else {
            m[field].push({ action_type: entry.action_type, value: entry.value });
          }
        });
      });
    });
    rows = Object.values(mergedByAdId);
  }

  if (!rows.length) {
    return { spend: 0, conversions: 0, revenue: 0, campaigns: 0, currency, accountId, ads: [], syncedAt: new Date().toISOString() };
  }

  // 2) thumbnails + UTM tags + 投放狀態 + 所屬行銷活動,matched by ad_id
  // relax=false(整月查詢)時,花費低於門檻的廣告反正後面一定會被篩掉,不用浪費請求去抓它們的細節——
  // 高流量帳號常常有大量低花費/已停用的廣告堆在資料裡,這樣可以大幅減少要打的「廣告清單」請求次數。
  // relax=true(週報表,放寬納入)時,需要知道每支廣告「現在是不是還在投放中」才能判斷要不要放寬納入,
  // 這個資訊只有查完廣告細節才知道,所以維持原本「不管花費多少,全部都先抓細節」的做法不變。
  const detailTargetRows = relaxThreshold ? rows : rows.filter((r) => (parseFloat(r.spend) || 0) >= MIN_FETCH_SPEND);
  const periodAdIds = [...new Set(detailTargetRows.map((r) => r.ad_id).filter(Boolean))];
  let thumbMap = {};
  let utmMap = {};
  let statusMap = {};
  let campaignMap = {};
  let startDateMap = {};
  let postIdMap = {};
  const ID_CHUNK_SIZE = 50;
  for (let i = 0; i < periodAdIds.length; i += ID_CHUNK_SIZE) {
    const chunk = periodAdIds.slice(i, i + ID_CHUNK_SIZE);
    const filtering = encodeURIComponent(JSON.stringify([{ field: "id", operator: "IN", value: chunk }]));
    let adsUrl =
      `${META_GRAPH_BASE}/act_${accountId}/ads?fields=id,name,url_tags,effective_status,created_time,campaign{name},adset{start_time},creative{thumbnail_url,image_url,url_tags,effective_object_story_id}` +
      `&filtering=${filtering}&limit=500&access_token=${encToken}`;
    let page2 = 0;
    while (adsUrl && page2 < 5) {
      const json = await fetchGraphApi(state, adsUrl, "讀取廣告清單");
      (json.data || []).forEach((ad) => {
        const thumb = ad.creative && (ad.creative.thumbnail_url || ad.creative.image_url);
        if (thumb) thumbMap[ad.id] = thumb;
        const tags = ad.url_tags || (ad.creative && ad.creative.url_tags) || "";
        if (tags) utmMap[ad.id] = extractUtmValue(tags);
        statusMap[ad.id] = ad.effective_status || "UNKNOWN";
        if (ad.campaign && ad.campaign.name) campaignMap[ad.id] = ad.campaign.name;
        const startRaw = (ad.adset && ad.adset.start_time) || ad.created_time || "";
        if (startRaw) startDateMap[ad.id] = startRaw;
        // effective_object_story_id = 「粉專ID_貼文ID」,不管是一般貼文還是廣告專用的隱藏貼文(dark post)都會有值,
        // 前端用這個組出「前往 FB 前台」的貼文連結(取代原本連到 Meta 廣告檔案庫、但一般商業廣告常常搜不到的做法)。
        const storyId = ad.creative && ad.creative.effective_object_story_id;
        if (storyId) postIdMap[ad.id] = storyId;
      });
      adsUrl = json.paging && json.paging.next ? json.paging.next : null;
      page2++;
    }
  }

  // 2.5) 貼文發佈時間(前台發表時間)——之前這個排序選項一直存在畫面上,但沒有意義,因為共用後端
  // (這支 Worker,所有品牌實際在用的資料來源)從來沒有算過這個欄位,只有前端「手動連接Meta API」
  // 那條沒人在用的舊路徑才有算。廣告投放起始時間不等於素材背後那則貼文真正發佈的時間
  // (例如拿一則很久以前的舊貼文來投放廣告,貼文發佈時間會比開始投放時間早很多)。
  // 用批次查詢一次把這段期間所有廣告用到的貼文發佈時間都抓回來,不是一支廣告分開查一次,
  // 避免多打幾十次 API 拖慢速度、更容易撞到頻率限制。沒有對應貼文的廣告,這裡就查不到值,
  // 前端會另外分區顯示,不會假裝有一個時間硬塞進去。
  // 這是「錦上添花」的附加資訊,不是核心的花費/業績數字。上一版用8秒時間預算還是不夠保險——
  // 問題不是這段查詢本身太慢,是「前面抓廣告清單/成效資料」在廣告數量多的月份已經逼近30秒了,
  // 這段不管設多保守的預算,只要有加,就可能把整個請求推過線。改成更直接的做法:
  // 貼文數量一多(代表廣告數量也多,很可能是月報表這種大範圍查詢),直接整段跳過不查,
  // 用「投放時間」排序來對付這種情境;貼文數量少(通常是週報表)才嘗試查,而且預算也縮短到3秒。
  const uniquePostIds = [...new Set(Object.values(postIdMap))];
  // 2026-08-03:報表要能依「貼文前台發佈時間」排序,所以每月報表也盡量抓這個欄位(原本只抓 ≤40 篇的週報表)。
  // 但實測高流量帳號(例如 H&J 一頁業績,單月 60+ 支廣告)的月查詢本來就逼近 30 秒上限,再加上這段抓取會
  // 直接逾時 500——而且那種帳號的廣告多半是「後台直接發佈(dark post)」,本來就查不到前台發佈時間。
  // 所以設一個上限跳過這種超大又抓不到資料的月查詢(前端會把它們當成「後台直接發佈」排最前面),
  // 保護月查詢不逾時;一般大小的月/週照常抓取。上限拉到 55(比原本 40 高、覆蓋更多一般月份),
  // 並收緊時間預算到 5 秒(批次每次 50 篇很快,正常月份幾次就抓完)。
  const MAX_POSTS_TO_CHECK = 55;
  let postPublishMap = {}; // story_id -> created_time
  if (uniquePostIds.length > 0 && uniquePostIds.length <= MAX_POSTS_TO_CHECK) {
    const postPublishBudgetStart = Date.now();
    const POST_PUBLISH_TIME_BUDGET_MS = 5000;
    for (let i = 0; i < uniquePostIds.length; i += ID_CHUNK_SIZE) {
      if (Date.now() - postPublishBudgetStart > POST_PUBLISH_TIME_BUDGET_MS) break; // 時間預算用完,查到多少算多少
      const chunk = uniquePostIds.slice(i, i + ID_CHUNK_SIZE);
      try {
        const json = await fetchGraphApi(
          state,
          `${META_GRAPH_BASE}/?ids=${chunk.join(",")}&fields=created_time&access_token=${encToken}`,
          "讀取貼文發佈時間",
          0 // 這裡不用內建重試(重試會疊加更多時間),查不到就算了,不影響核心資料
        );
        Object.entries(json || {}).forEach(([storyId, obj]) => {
          if (obj && obj.created_time) postPublishMap[storyId] = obj.created_time;
        });
      } catch {
        /* 查不到就算了,對應廣告會被歸類到「沒有對應貼文」那一區,不會擋住其他資料 */
      }
    }
  }
  const postPublishDateMap = {}; // ad.id -> 貼文發佈時間(查得到的話)
  Object.entries(postIdMap).forEach(([adId, storyId]) => {
    if (postPublishMap[storyId]) postPublishDateMap[adId] = postPublishMap[storyId];
  });

  // 3) 先用「完整、未篩選」的資料算總計,跟 Meta 後台的帳號總覽數字完全一致
  let totalSpend = 0,
    totalConv = 0,
    totalRev = 0;
  rows.forEach((row) => {
    totalSpend += parseFloat(row.spend) || 0;
    totalConv += pickPurchaseValue(row.actions);
    totalRev += pickPurchaseValue(row.action_values);
  });

  const detailRows = rows.filter((row) => {
    const spend = parseFloat(row.spend) || 0;
    if (spend >= MIN_FETCH_SPEND) return true;
    if (relaxThreshold && statusMap[row.ad_id] === "ACTIVE") return true;
    return false;
  });

  // 4) aggregate, merging ads that share the same UTM tag(投放中/已停止絕對不合併)
  const grouped = {};
  detailRows.forEach((row) => {
    const spend = parseFloat(row.spend) || 0;
    const conversions = pickPurchaseValue(row.actions);
    const revenue = pickPurchaseValue(row.action_values);

    const adName = row.ad_name || "(未命名廣告)";
    const utm = utmMap[row.ad_id] || "";
    const isActive = statusMap[row.ad_id] === "ACTIVE";
    // 之前這裡分組只看UTM,同一個UTM標籤如果被套用在好幾個完全不同的行銷活動上,這些廣告會被誤
    // 合併成一筆,campaign欄位就會擠出一長串不同活動名稱。改成分組key同時看UTM+行銷活動名稱,
    // 兩個都相同才會合併,不同行動方案一律拆開各自一筆。
    const campaignName = campaignMap[row.ad_id] || "(未分類活動)";
    const groupKey = (utm ? "utm:" + utm : "ad:" + row.ad_id) + "::campaign:" + campaignName + "::" + (isActive ? "on" : "off");
    if (!grouped[groupKey]) {
      grouped[groupKey] = {
        utm,
        names: new Set(),
        image: "",
        postId: "",
        spend: 0,
        conversions: 0,
        revenue: 0,
        active: isActive,
        campaigns: new Set(),
        adIds: new Set(),
        startDate: null,
        postPublishDate: null,
      };
    }
    const g = grouped[groupKey];
    g.names.add(adName);
    g.spend += spend;
    g.conversions += conversions;
    g.revenue += revenue;
    if (!g.image && thumbMap[row.ad_id]) g.image = thumbMap[row.ad_id];
    if (!g.postId && postIdMap[row.ad_id]) g.postId = postIdMap[row.ad_id];
    if (campaignMap[row.ad_id]) g.campaigns.add(campaignMap[row.ad_id]);
    if (row.ad_id) g.adIds.add(row.ad_id);
    const rowStart = startDateMap[row.ad_id];
    if (rowStart && (!g.startDate || rowStart < g.startDate)) g.startDate = rowStart;
    const rowPostPublish = postPublishDateMap[row.ad_id];
    if (rowPostPublish && (!g.postPublishDate || rowPostPublish < g.postPublishDate)) g.postPublishDate = rowPostPublish;
  });

  const ads = Object.values(grouped)
    .map((g) => {
      const nameList = [...g.names];
      const name =
        nameList.length === 0
          ? g.utm || "未命名廣告"
          : nameList.length === 1
          ? nameList[0]
          : `${nameList[0]} 等 ${nameList.length} 支廣告`;
      const campaignList = [...g.campaigns];
      const campaign =
        campaignList.length === 0
          ? "(未分類活動)"
          : campaignList.length === 1
          ? campaignList[0]
          : `${campaignList[0]} 等 ${campaignList.length} 個活動`;
      return {
        name,
        utm: g.utm,
        image: g.image,
        postId: g.postId,
        spend: g.spend,
        conversions: g.conversions,
        revenue: g.revenue,
        adCount: nameList.length || 1,
        rawNames: nameList,
        active: g.active,
        campaign,
        adIds: [...g.adIds],
        startDate: g.startDate,
        postPublishDate: g.postPublishDate,
      };
    })
    .sort((a, b) => b.spend - a.spend);

  return { spend: totalSpend, conversions: totalConv, revenue: totalRev, campaigns: 0, currency, accountId, ads, syncedAt: new Date().toISOString() };
}

async function handleMetaTimezone(url, env, origin) {
  if (!env.META_TOKEN) {
    return jsonResponse({ error: "Worker 還沒設定 META_TOKEN。" }, 500, origin);
  }
  const accountId = url.searchParams.get("accountId");
  const allowedAccounts = await getAllowedMetaAccounts(env);
  if (!accountId || !allowedAccounts[accountId]) {
    return jsonResponse(
      { error: `accountId 不在允許清單裡(收到的值:"${accountId || ""}")。` },
      400,
      origin
    );
  }
  const state = newThrottleState();
  const utcOffsetHours = await fetchAccountUtcOffset(state, env.META_TOKEN, accountId);
  return jsonResponse({ utcOffsetHours }, 200, origin);
}

async function handleMetaInsights(url, env, origin) {
  if (!env.META_TOKEN) {
    return jsonResponse({ error: "Worker 還沒設定 META_TOKEN。" }, 500, origin);
  }
  const accountId = url.searchParams.get("accountId");
  const allowedAccounts = await getAllowedMetaAccounts(env);
  if (!accountId || !allowedAccounts[accountId]) {
    return jsonResponse(
      { error: `accountId 不在允許清單裡(收到的值:"${accountId || ""}")。` },
      400,
      origin
    );
  }
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  const relax = url.searchParams.get("relax") === "true";
  if (!since || !until) {
    return jsonResponse({ error: "請帶入 since 與 until 參數,格式為 YYYY-MM-DD。" }, 400, origin);
  }
  const state = newThrottleState();
  try {
    const record = await fetchInsightsForRange(state, env.META_TOKEN, accountId, since, until, relax);
    return jsonResponse(record, 200, origin);
  } catch (e) {
    return jsonResponse({ error: "抓取 Meta 廣告成效失敗:" + e.message + metaApiErrorHint(e) }, 500, origin);
  }
}

// 圖片代理:讓「沒有 Facebook 權限的觀看者(例如品牌方)」也能看到 Meta 廣告縮圖。
// 背景:Meta 回傳的縮圖是 *.fbcdn.net 的網址,而且常常是綁「當下登入 FB 那個 session」
// 的 fan-network(.fna.)網址,只有登入 FB 且對這個廣告帳號有權限的人(管理員)瀏覽器載得出來,
// 品牌方直接連 fbcdn 會被擋掉(403)。這裡改由 Worker 在伺服器端去抓圖、再回傳給前端,
// 前端的 <img> 指向這個端點而不是直接指向 Facebook,任何人都看得到,不需要自己有 FB 權限。
// 安全:只允許代理 *.fbcdn.net / *.facebook.com 的圖片,避免變成任意網址的開放代理(SSRF)。
// 這個端點「不需要」X-Proxy-Auth——因為 <img src> 沒辦法帶自訂 header,而且只回圖片、
// 又鎖死了只能抓 Facebook 圖床,風險很低。
async function handleImageProxy(url, request, origin) {
  const raw = url.searchParams.get("u");
  if (!raw) return new Response("missing u", { status: 400, headers: corsHeaders(origin) });
  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad url", { status: 400, headers: corsHeaders(origin) });
  }
  const host = target.hostname.toLowerCase();
  const allowed =
    target.protocol === "https:" &&
    (host === "fbcdn.net" || host.endsWith(".fbcdn.net") || host.endsWith(".facebook.com"));
  if (!allowed) {
    return new Response("host not allowed", { status: 403, headers: corsHeaders(origin) });
  }

  // 先看 Cloudflare 邊緣快取有沒有(用整個代理請求網址當 key,含 fbcdn 的簽章參數,
  // 換一批新網址就自然是新的 key)。
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: "https://www.facebook.com/",
      },
    });
  } catch {
    // 伺服器端抓不到(例如網址已過期):導回原網址,讓有 FB 權限的人至少還看得到,
    // 沒權限的人前端會退回「素材」框,不比現況差。
    return Response.redirect(target.toString(), 302);
  }
  if (!upstream.ok) {
    return Response.redirect(target.toString(), 302);
  }
  const contentType = upstream.headers.get("Content-Type") || "image/jpeg";
  const body = await upstream.arrayBuffer();
  const resp = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      // 縮圖內容不太會變,快取一天,減少對 fbcdn 的重複請求。
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": origin || "*",
    },
  });
  try {
    await cache.put(cacheKey, resp.clone());
  } catch {
    /* 快取寫入失敗不影響回應 */
  }
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // 圖片代理:放在密碼驗證「之前」,因為 <img src> 沒辦法帶 X-Proxy-Auth header。
    // 只代理 Facebook 圖床、只回圖片,公開存取沒關係。
    if (url.pathname === "/api/img" && request.method === "GET") {
      return await handleImageProxy(url, request, origin);
    }

    // 品牌清單只是名稱跟 ID,不是真正的營收資料,公開查看沒關係,所以放在密碼驗證「之前」處理。
    if (url.pathname === "/api/meta/brands" && request.method === "GET") {
      const allowedAccounts = await getAllowedMetaAccounts(env);
      const brands = Object.entries(allowedAccounts).map(([id, name]) => ({ id, name }));
      return jsonResponse({ brands }, 200, origin);
    }

    try {
      // 驗證:除了上面兩種例外之外,其他請求都要帶對的密碼才放行。
      const providedSecret = request.headers.get("X-Proxy-Auth") || "";
      if (!env.PROXY_SECRET || providedSecret !== env.PROXY_SECRET) {
        return jsonResponse({ error: "驗證失敗:密碼不對或沒有帶密碼。" }, 401, origin);
      }

      if (url.pathname === "/api/orders" && request.method === "GET") {
        return await handleOrders(url, env, origin);
      }
      if (url.pathname === "/api/meta/timezone" && request.method === "GET") {
        return await handleMetaTimezone(url, env, origin);
      }
      if (url.pathname === "/api/meta/insights" && request.method === "GET") {
        return await handleMetaInsights(url, env, origin);
      }
      // 暫時除錯:直接看 Meta 對「貼文 created_time」查詢回什麼(診斷為什麼抓不到前台發佈時間)。
      // 用法:/api/meta/debug-postpublish?ids=<story_id1>,<story_id2>
      if (url.pathname === "/api/meta/debug-postpublish" && request.method === "GET") {
        const ids = url.searchParams.get("ids");
        if (!ids) return jsonResponse({ error: "need ids" }, 400, origin);
        const encToken = encodeURIComponent(env.META_TOKEN || "");
        const gu = `${META_GRAPH_BASE}/?ids=${encodeURIComponent(ids)}&fields=created_time,is_published,is_expired,promotable_id&access_token=${encToken}`;
        const gr = await fetch(gu);
        const gtxt = await gr.text();
        return jsonResponse({ status: gr.status, raw: gtxt.slice(0, 1800) }, 200, origin);
      }
      if (url.pathname === "/" || url.pathname === "") {
        return jsonResponse(
          {
            ok: true,
            version: "2026-08-03-image-proxy-postpublish-capped55",
            message:
              "代理 Worker 運作中。呼叫範例: /api/orders?since=...&until=... 或 /api/meta/insights?since=...&until=...",
          },
          200,
          origin
        );
      }
      return jsonResponse({ error: "找不到這個路徑。" }, 404, origin);
    } catch (err) {
      return jsonResponse({ error: err.message || String(err) }, 500, origin);
    }
  },
};
