/* Premium Laundry - voice entry helper (TEST, v0.4.0)
 * Turns a spoken sentence into form values. It never saves anything: the app shows the
 * normal form, filled in, and Mariama checks it and confirms before saving.
 * Speech-to-text uses the browser's free built-in recognition (Chrome on Android).
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ spoken numbers
  const UNITS = { zero: 0, oh: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
  const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const SCALES = { hundred: 100, thousand: 1000, k: 1000, million: 1000000 };

  // Replaces runs of number words ("one thousand two hundred and fifty", "fifteen hundred") with digits.
  function wordsToDigits(text) {
    const toks = text.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < toks.length) {
      const w = toks[i];
      const isNumWord = x => x in UNITS || x in TENS || x in SCALES;
      // "a"/"an"/"oh" only count as numbers when followed by a scale word ("a hundred")
      const startsRun = (isNumWord(w) && !(["a", "an", "oh", "k"].includes(w) && !(toks[i + 1] in SCALES))) ||
        (/^\d+(\.\d+)?$/.test(w) && (toks[i + 1] === "hundred" || toks[i + 1] === "thousand" || toks[i + 1] === "million"));
      if (!startsRun) { out.push(w); i++; continue; }
      let total = 0, current = 0, used = 0, j = i;
      while (j < toks.length) {
        const x = toks[j];
        if (x === "and" && used && j + 1 < toks.length && (toks[j + 1] in UNITS || toks[j + 1] in TENS)) { j++; continue; }
        if (x in UNITS && !(["a", "an"].includes(x) && !(toks[j + 1] in SCALES))) { current += UNITS[x]; }
        else if (x in TENS) {
          // colloquial "eight fifty" = 850, "twelve fifty" = 1250 (a unit/teen directly followed by a tens word)
          const prev = toks[j - 1];
          if (used && (prev in UNITS) && current % 100 === UNITS[prev] && current > 0 && current < 100) current = current * 100 + TENS[x];
          else current += TENS[x];
        }
        else if (x === "hundred") { current = (current || 1) * 100; }
        else if (x === "thousand" || x === "k") { total += (current || 1) * 1000; current = 0; }
        else if (x === "million") { total += (current || 1) * 1000000; current = 0; }
        else if (/^\d+(\.\d+)?$/.test(x) && (toks[j + 1] === "thousand" || toks[j + 1] === "hundred" || toks[j + 1] === "million")) { current += Number(x); }
        else break;
        used++; j++;
      }
      out.push(String(total + current)); i = j;
    }
    return out.join(" ");
  }

  function normaliseText(raw) {
    let t = " " + String(raw || "").toLowerCase() + " ";
    t = t.replace(/[’']/g, "").replace(/(\d),(\d{3})/g, "$1$2").replace(/(\d),(\d{3})/g, "$1$2");
    t = t.replace(/\b(gmd|d)\s*(\d)/g, "$2");                      // D500, GMD 500
    t = t.replace(/(\d+(?:\.\d+)?)\s*k\b/g, (m, n) => String(Math.round(Number(n) * 1000)));   // 1.5k, 2 k
    t = t.replace(/(\d)\s*(d|gmd)\b/g, "$1");                      // 500D
    t = t.replace(/[^a-z0-9.\s-]/g, " ").replace(/-/g, " ");
    t = wordsToDigits(t.replace(/\s+/g, " ").trim());
    // "1 thousand" / "2 hundred" written by the recogniser with digits
    t = t.replace(/\b(\d+)\s+thousand\b/g, (m, n) => String(Number(n) * 1000)).replace(/\b(\d+)\s+hundred\b/g, (m, n) => String(Number(n) * 100));
    t = t.replace(/\b(\d+)\s+(\d{3})\b/g, (m, a, b) => Number(a) % 1000 === 0 ? String(Number(a) + Number(b)) : m);   // "2000 500" -> 2500
    return t.replace(/\b(dalasi|dalasis|dalassi|delasi|dollars?|dalas)\b/g, " ").replace(/\s+/g, " ").trim();
  }

  // ------------------------------------------------------------ names (Gambian spellings)
  function phoneticKey(s) {
    let t = String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
    if (!t) return "";
    t = t.replace(/ph/g, "f").replace(/kh/g, "k").replace(/gh/g, "g").replace(/ck/g, "k").replace(/q/g, "k")
      .replace(/c(?=[aou]|$)/g, "k").replace(/x/g, "ks").replace(/z/g, "s").replace(/dj/g, "j")
      .replace(/^g(?=[ie])/g, "j").replace(/th/g, "t").replace(/sh/g, "s").replace(/ch/g, "s")
      .replace(/ou|oo|w/g, "u").replace(/ee|ie$|y/g, "i").replace(/ey$|ay$/g, "i");
    t = t.charAt(0) + t.slice(1).replace(/h/g, "");                    // Ahmed/Amed, Khady/Kady
    t = t.replace(/(.)\1+/g, "$1");                                     // Haddy/Hady, Jibriil/Jibril
    if (t.length > 3) t = t.replace(/e$/, "");                          // Ousmane/Ousman, Lamine/Lamin
    return t;
  }
  const NAME_FAMILIES = { momodou: "modou", mamadou: "modou", mohammed: "muhammed", mohamed: "muhammed", muhammad: "muhammed",
    mohamadou: "modou", ibrahima: "ebrima", ibrahim: "ebrima", ebrahim: "ebrima", fatoumata: "fatou", fatimata: "fatou",
    ndeye: "ndey", seynabou: "sainabou", seinabou: "sainabou", youssouf: "yusupha", yusuf: "yusupha", yousouf: "yusupha",
    aliou: "alieu", alhagie: "alhaji", alhaji: "alhaji", omar: "omar", oumar: "omar", ousmane: "ousman", usman: "ousman",
    ousainou: "ousainou", awa: "awa", aminata: "aminata", aminatou: "aminata", mariam: "mariama", mariamma: "mariama",
    haddy: "hadi", haddi: "hadi", hadi: "hadi", kaddy: "kadi", khady: "kadi", kadi: "kadi", khadi: "kadi", kadie: "kadi",
    isatou: "isatou", isatu: "isatou", isha: "isatou", bakary: "bakari", bakari: "bakari", lamine: "lamin" };
  const canon = s => String(s).split(" ").map(w => NAME_FAMILIES[w] || w).join(" ");
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function sim(a, b) {
    if (!a || !b) return 0;
    a = canon(a); b = canon(b);
    const ka = phoneticKey(a), kb = phoneticKey(b);
    const p = 1 - lev(ka, kb) / Math.max(ka.length, kb.length);
    const r = 1 - lev(a, b) / Math.max(a.length, b.length);
    return Math.max(p, r);
  }
  const IGNORE_IN_NAMES = new Set(["test"]);
  function nameVariants(c) {
    const out = [];
    [c.name].concat(String(c.otherSpellings || "").split(",")).forEach(n => {
      const words = String(n).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z\s]/g, " ")
        .split(/\s+/).filter(w => w && !IGNORE_IN_NAMES.has(w));
      if (!words.length) return;
      out.push(words.join(" "));
      if (words.length > 1) { out.push(words[0]); out.push(words.slice(0, 2).join(" ")); }
    });
    return out;
  }

  // ------------------------------------------------------------ vocabulary
  const STOP = new Set(("a an the and of for to from with by at in on is was has have had her his my i we she he they it this that " +
    "today now please just also only then so ok okay yes no dalasi dalasis money amount total balance rest remaining customer customers name called " +
    "mr mrs miss madam auntie aunty uncle brother sister mama papa baby").split(" "));
  const CHARGE_WORDS = /\b(brought|bring|brings|bringing|dropped|drop|drops|left|bill|billed|charge|charged|wash|washing|washed|iron|ironing|ironed|laundry|clothes|cloth|clothing|order|starch)\b/;
  const PAY_WORDS = /\b(paid|pays|pay|paying|payment|gave|give|gives|settled|settle|cleared|clear|received|receive|collected|deposit|advance)\b/;
  const EXPENSE_WORDS = /\b(expense|expenses|spent|spend|spending|bought|buy|buying|purchase|purchased|cost)\b/;
  const NEW_CUSTOMER = /\b(new customer|register|add customer|new client)\b/;
  const ITEM_WORDS = /^(shirts?|trousers?|pants?|dress(es)?|suits?|jackets?|bedsheets?|sheets?|bed|curtains?|towels?|blankets?|duvets?|kaftans?|grand|boubous?|uniforms?|skirts?|blouses?|jeans|pieces?|items?|bags?|bottles?|packets?|kilos?|kg|cartons?|boxes?|tins?|litres?|liters?)$/;
  const METHODS = [
    [/\b(wave|afrimoney|afri money|africell money|q ?money|qcell|mobile money|momo|mobile|orange money|transfer by phone|phone money)\b/, "Mobile money"],
    [/\b(bank|transfer|cheque|check|card|pos|trust bank|ecobank|gtbank|access bank)\b/, "Bank"],
    [/\b(cash|hand|hands|kash)\b/, "Cash"]
  ];
  const METHOD_WORDS = /\b(wave|afrimoney|afri|africell|money|q|qmoney|qcell|mobile|momo|orange|bank|transfer|cheque|check|card|pos|trust|ecobank|gtbank|access|cash|hand|hands|kash|phone|by|with|via|through|using)\b/;
  const CATEGORIES = [
    [/\b(electricity|nawec|current|light|cash power|cashpower|power|units)\b/, "Electricity"],
    [/\b(water)\b/, "Water"],
    [/\b(detergent|soap|omo|powder|bleach|jik|starch|softener|sunlight|ariel|klin|madar|chlorine)\b/, "Detergent"],
    [/\b(packaging|package|bags?|plastic|plastics|nylon|hangers?|wrapping|wrap)\b/, "Packaging"],
    [/\b(food|meal|meals|lunch|breakfast|dinner|chop|rice|staff meal)\b/, "Staff meals"],
    [/\b(allowance|allowances|lunch money|transport money)\b/, "Staff allowances"],
    [/\b(salary|salaries|wage|wages|pay staff)\b/, "Salaries"],
    [/\b(rent|shop rent)\b/, "Rent"],
    [/\b(transport|taxi|gele|gelegele|fuel|petrol|diesel|bus|car|fare)\b/, "Transport"],
    [/\b(repair|repairs|maintenance|fix|fixed|fixing|mechanic|spare|parts)\b/, "Maintenance"]
  ];

  // ------------------------------------------------------------ main parser
  function parse(raw, customers, opts) {
    opts = opts || {};
    const text = normaliseText(raw);
    const words = text.split(" ").filter(Boolean);
    const res = { transcript: String(raw || ""), normalised: text, type: "", customerId: "", customerName: "", suggestions: [], spokenName: "",
      amount: null, paidNow: null, method: "", category: "", description: "", warnings: [] };

    // numbers with their position; numbers followed by an item word are counts, not money
    const nums = [];
    words.forEach((w, i) => {
      if (/^\d+(\.\d+)?$/.test(w) && !ITEM_WORDS.test(words[i + 1] || "")) nums.push({ v: Number(w), i });
    });
    const paidIdx = words.findIndex(w => /^(paid|pays|pay|paying|gave|give|gives|deposit|advance|received)$/.test(w));

    for (const [re, m] of METHODS) if (re.test(text)) { res.method = m; break; }

    // intent
    const hasExpense = EXPENSE_WORDS.test(text) || /^(expense|expenses)\b/.test(text);
    const cat = CATEGORIES.find(([re]) => re.test(text));
    if (NEW_CUSTOMER.test(text)) res.type = "customer";
    else if (hasExpense) res.type = "expense";
    else if (CHARGE_WORDS.test(text)) res.type = "charge";
    else if (PAY_WORDS.test(text)) res.type = "payment";
    else if (cat) res.type = "expense";

    // amounts
    if (res.type === "charge") {
      const paidNum = paidIdx >= 0 ? nums.find(n => n.i > paidIdx) : null;
      const billNum = nums.find(n => n !== paidNum);
      res.amount = billNum ? billNum.v : null;
      res.paidNow = paidNum ? paidNum.v : (/\b(paid (in )?full|fully paid|paid (it )?all|paid everything|paid the whole|full payment)\b/.test(text) && billNum ? billNum.v : 0);
      if (res.amount != null && res.paidNow > res.amount) { const t = res.amount; res.amount = res.paidNow; res.paidNow = t; res.warnings.push("Please check which amount is the bill and which was paid."); }
      if (nums.length > 2) res.warnings.push("I heard more than two amounts. Please check them.");
    } else if (res.type === "payment" || res.type === "expense") {
      res.amount = nums.length ? nums[0].v : null;
      if (nums.length > 1) res.warnings.push("I heard more than one amount. Please check it.");
    }
    if (res.type === "expense") {
      res.category = cat ? cat[1] : "Other";
      res.description = words.filter(w => !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w) && !EXPENSE_WORDS.test(w) && !METHOD_WORDS.test(w)).join(" ");
    }

    // customer name: try 1-3 word windows of the remaining words against registered customers
    if (res.type !== "expense") {
      const keep = words.filter(w => !STOP.has(w) && !/^\d/.test(w) && !CHARGE_WORDS.test(w) && !PAY_WORDS.test(w) && !ITEM_WORDS.test(w) &&
        !METHOD_WORDS.test(w) && !/^(new|register|add|client)$/.test(w));
      res.spokenName = keep.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
      if (res.type === "charge") {
        const itemWords = []; words.forEach((w, i) => { if (ITEM_WORDS.test(w)) itemWords.push((/^\d+$/.test(words[i - 1] || "") ? words[i - 1] + " " : "") + w); });
        res.description = itemWords.join(", ");
      }
      if (res.type !== "customer" && keep.length && Array.isArray(customers)) {
        const grams = [];
        for (let n = 3; n >= 1; n--) for (let s = 0; s + n <= keep.length; s++) grams.push(keep.slice(s, s + n).join(" "));
        const scored = customers.map(c => {
          let best = 0;
          const spoken = Math.min(keep.length, 3);
          nameVariants(c).forEach(v => grams.forEach(g => {
            const gw = g.split(" ").length;
            const sc = sim(g, v) - (v.split(" ").length !== gw ? 0.03 : 0) - 0.06 * (spoken - gw);
            if (sc > best) best = sc;
          }));
          return { id: c.id, name: c.name, score: Math.round(best * 100) / 100 };
        }).filter(x => x.score >= 0.6).sort((a, b) => b.score - a.score);
        res.suggestions = scored.slice(0, 4);
        const top = scored[0], second = scored[1];
        if (top && top.score >= 0.8 && (!second || top.score - second.score >= 0.08)) { res.customerId = top.id; res.customerName = top.name; }
        else if (top) res.warnings.push("Please choose the right customer.");
        else res.warnings.push("Customer not found. Choose from the list or register a new customer.");
      }
    }
    if (res.type === "payment" && !res.customerId && !(res.suggestions[0] && res.suggestions[0].score >= 0.8) && cat) {
      res.type = "expense"; res.category = cat[1]; res.suggestions = []; res.customerName = "";
      res.warnings = res.warnings.filter(w => !/customer/i.test(w));
      res.description = words.filter(w => !STOP.has(w) && !/^\d+(\.\d+)?$/.test(w) && !PAY_WORDS.test(w) && !METHOD_WORDS.test(w)).join(" ");
    }
    if (!res.type) res.warnings.push("I could not tell if this is a bill, a payment or an expense.");
    if ((res.type === "charge" || res.type === "payment" || res.type === "expense") && res.amount == null) res.warnings.push("I did not hear an amount.");
    return res;
  }

  // Picks the best of several recogniser alternatives (the one that matches a customer best and has an amount).
  function parseBest(alternatives, customers) {
    const results = (alternatives || []).filter(Boolean).map(a => parse(a, customers));
    if (!results.length) return parse("", customers);
    const score = r => (r.type ? 2 : 0) + (r.amount != null ? 2 : 0) + (r.customerId ? 3 : 0) + (r.suggestions[0] ? r.suggestions[0].score : 0) - r.warnings.length * 0.5;
    return results.sort((a, b) => score(b) - score(a))[0];
  }

  const api = { parse, parseBest, normaliseText, wordsToDigits, phoneticKey, sim };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PLVoice = api;
})(typeof window !== "undefined" ? window : this);
