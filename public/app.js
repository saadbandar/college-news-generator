(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const INPUT_FIELDS = ["freeText", "eventName", "organizer", "date", "location", "audience", "presenter", "topics", "objectives", "highlights", "extra"];
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const STORAGE_KEY = "college-news-draft-v1";

  const state = {
    step: 1,
    input: {},
    images: [], // {id, name, type, data, width, height, url, altAr, altEn, main, busy}
    news: null, // {ar_title, ar_body, en_title, en_body, organizer, event_date, missing_info}
    enStale: false,
    approved: false,
    credentials: true,
  };

  /* ---------------- أدوات عامة ---------------- */
  let toastTimer;
  function toast(msg, type = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = `toast ${type ? "toast--" + type : ""}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4200);
  }

  function setLoading(btn, on) {
    btn.classList.toggle("is-loading", on);
    btn.disabled = on;
    const sp = $(".btn__spinner", btn);
    if (sp) sp.hidden = !on;
  }

  async function api(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = `خطأ (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  async function apiBlob(path, body) {
    const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) {
      let msg = `خطأ (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return res.blob();
  }

  function paragraphsHtml(text) {
    return (text || "")
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join("");
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function wordCount(s) {
    return (s || "").trim().split(/\s+/).filter(Boolean).length;
  }
  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg, "ok");
    } catch {
      toast("تعذر النسخ إلى الحافظة.", "error");
    }
  }
  function safeFileName(name) {
    return (name || "خبر").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
  }

  /* ---------------- التخزين المحلي ---------------- */
  function saveDraft() {
    try {
      const { images, ...rest } = state;
      const imgs = images.map(({ url, busy, ...i }) => i);
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...rest, images: imgs }));
    } catch {}
  }
  function loadDraft() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      Object.assign(state, { input: d.input || {}, news: d.news || null, enStale: !!d.enStale, approved: !!d.approved, step: d.step || 1 });
      state.images = (d.images || []).map((i) => ({ ...i, url: `data:${i.type};base64,${i.data}`, busy: false }));
    } catch {}
  }

  /* ---------------- التنقل ---------------- */
  function canEnter(step) {
    if (step >= 3 && !INPUT_FIELDS.some((k) => (state.input[k] || "").trim())) {
      toast("أدخل معلومات الفعالية أولًا.", "error");
      return false;
    }
    if (step >= 4 && !state.news) {
      toast("ولّد الخبر أولًا.", "error");
      return false;
    }
    return true;
  }
  function goTo(step) {
    if (!canEnter(step)) return;
    state.step = step;
    $$(".panel").forEach((p) => (p.hidden = Number(p.dataset.panel) !== step));
    $$(".step").forEach((s) => {
      const n = Number(s.dataset.step);
      s.classList.toggle("is-active", n === step);
      s.classList.toggle("is-done", n < step);
    });
    if (step === 4) renderEditor();
    if (step === 5) renderFinal();
    window.scrollTo({ top: 0, behavior: "smooth" });
    saveDraft();
  }

  /* ---------------- المرحلة 1: المدخلات ---------------- */
  function readInputs() {
    INPUT_FIELDS.forEach((k) => (state.input[k] = $("#" + k).value));
    saveDraft();
  }
  function writeInputs() {
    INPUT_FIELDS.forEach((k) => ($("#" + k).value = state.input[k] || ""));
  }

  /* ---------------- المرحلة 2: الصور ---------------- */
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("تعذر قراءة الملف"));
      reader.onload = () => {
        const url = reader.result;
        const img = new Image();
        img.onload = () =>
          resolve({
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            data: url.split(",")[1],
            width: img.naturalWidth,
            height: img.naturalHeight,
            url,
            altAr: "",
            altEn: "",
            main: false,
            busy: false,
          });
        img.onerror = () => reject(new Error("الملف ليس صورة صالحة"));
        img.src = url;
      };
      reader.readAsDataURL(file);
    });
  }

  async function addFiles(files) {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    for (const f of files) {
      if (!allowed.includes(f.type)) { toast(`الملف ${f.name} ليس بصيغة مدعومة.`, "error"); continue; }
      if (f.size > MAX_IMAGE_BYTES) { toast(`الصورة ${f.name} أكبر من 10 ميجابايت.`, "error"); continue; }
      try {
        const img = await fileToImage(f);
        if (!state.images.some((i) => i.main)) img.main = true;
        state.images.push(img);
      } catch (e) {
        toast(e.message, "error");
      }
    }
    renderImages();
    saveDraft();
    if (state.credentials) {
      state.images.filter((i) => !i.altAr && !i.altEn && !i.busy).forEach((i) => generateAlt(i.id));
    }
  }

  function altContext() {
    return {
      eventName: state.input.eventName,
      organizer: state.input.organizer || state.news?.organizer,
      ar_title: state.news?.ar_title,
      date: state.input.date,
      location: state.input.location,
    };
  }

  async function generateAlt(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img || img.busy) return;
    img.busy = true;
    renderImages();
    try {
      const r = await api("/api/alt-text", { image: { type: img.type, data: img.data }, context: altContext() });
      img.altAr = r.alt_ar || "";
      img.altEn = r.alt_en || "";
    } catch (e) {
      toast(`تعذر توليد النص البديل: ${e.message}`, "error");
    } finally {
      img.busy = false;
      renderImages();
      saveDraft();
    }
  }

  function renderImages() {
    const wrap = $("#imagesList");
    if (!state.images.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = state.images
      .map(
        (img) => `
      <div class="img-card ${img.main ? "is-main" : ""}" data-id="${img.id}">
        <div class="img-card__preview">
          <img src="${img.url}" alt="${escapeHtml(img.altAr || img.name)}" />
          ${img.main ? '<span class="img-card__main">الصورة الرئيسية</span>' : ""}
        </div>
        <div class="img-card__body">
          <div class="img-card__name" title="${escapeHtml(img.name)}">${escapeHtml(img.name)} — ${img.width}×${img.height}</div>
          <label class="field"><span class="field__label">النص البديل للصورة (Alt Text) — عربي</span>
            <textarea rows="3" data-alt="ar" ${img.busy ? "disabled" : ""} placeholder="${img.busy ? "جارٍ تحليل الصورة..." : "اكتب وصفًا دقيقًا أو ولّده تلقائيًا"}">${escapeHtml(img.altAr)}</textarea></label>
          <label class="field" dir="ltr"><span class="field__label">Image Alt Text — English</span>
            <textarea rows="3" data-alt="en" ${img.busy ? "disabled" : ""} placeholder="${img.busy ? "Analyzing image..." : "Write or generate an accurate description"}">${escapeHtml(img.altEn)}</textarea></label>
          <div class="img-card__tools">
            <button class="btn btn--sm" data-act="alt" ${img.busy ? "disabled" : ""}>${img.busy ? '<span class="btn__spinner"></span> جارٍ التوليد' : (img.altAr ? "إعادة توليد النص البديل" : "توليد النص البديل")}</button>
            <button class="btn btn--sm" data-act="replace">استبدال</button>
            <button class="btn btn--sm btn--danger" data-act="delete">حذف</button>
            <label class="check"><input type="radio" name="mainImage" data-act="main" ${img.main ? "checked" : ""}/> رئيسية</label>
          </div>
        </div>
      </div>`,
      )
      .join("");
  }

  let replaceTargetId = null;
  function bindImages() {
    const dz = $("#dropzone");
    const fi = $("#fileInput");
    dz.addEventListener("click", () => { replaceTargetId = null; fi.multiple = true; fi.click(); });
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dz.click(); } });
    ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("is-over"); }));
    ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("is-over"); }));
    dz.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));
    fi.addEventListener("change", async () => {
      const files = [...fi.files];
      fi.value = "";
      if (replaceTargetId && files[0]) {
        const idx = state.images.findIndex((i) => i.id === replaceTargetId);
        replaceTargetId = null;
        if (idx >= 0) {
          try {
            const img = await fileToImage(files[0]);
            img.main = state.images[idx].main;
            state.images[idx] = img;
            renderImages();
            saveDraft();
            if (state.credentials) generateAlt(img.id);
          } catch (e) { toast(e.message, "error"); }
        }
        return;
      }
      addFiles(files);
    });

    const list = $("#imagesList");
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const card = e.target.closest(".img-card");
      const id = card.dataset.id;
      const act = btn.dataset.act;
      if (act === "alt") generateAlt(id);
      if (act === "delete") {
        const wasMain = state.images.find((i) => i.id === id)?.main;
        state.images = state.images.filter((i) => i.id !== id);
        if (wasMain && state.images[0]) state.images[0].main = true;
        renderImages();
        saveDraft();
      }
      if (act === "replace") { replaceTargetId = id; fi.multiple = false; fi.click(); }
    });
    list.addEventListener("change", (e) => {
      if (e.target.dataset.act === "main") {
        const id = e.target.closest(".img-card").dataset.id;
        state.images.forEach((i) => (i.main = i.id === id));
        renderImages();
        saveDraft();
      }
    });
    list.addEventListener("input", (e) => {
      const t = e.target;
      if (!t.dataset.alt) return;
      const img = state.images.find((i) => i.id === t.closest(".img-card").dataset.id);
      if (!img) return;
      if (t.dataset.alt === "ar") img.altAr = t.value; else img.altEn = t.value;
      saveDraft();
    });
  }

  /* ---------------- المرحلة 3: التوليد ---------------- */
  async function generate(regenerate = false) {
    readInputs();
    if (!INPUT_FIELDS.some((k) => (state.input[k] || "").trim())) { toast("أدخل معلومات الفعالية أولًا.", "error"); return; }
    const btn = regenerate ? $("#regenerateBtn") : $("#generateBtn");
    setLoading($("#generateBtn"), true);
    setLoading($("#regenerateBtn"), true);
    $(".btn__text", $("#generateBtn")).textContent = "جارٍ صياغة الخبر...";
    try {
      const r = await api("/api/generate", { input: state.input, previous: regenerate ? state.news : undefined });
      state.news = r;
      state.enStale = false;
      state.approved = false;
      renderGenerated();
      toast("تم توليد الخبر بنجاح.", "ok");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setLoading($("#generateBtn"), false);
      setLoading($("#regenerateBtn"), false);
      $(".btn__text", $("#generateBtn")).textContent = state.news ? "توليد من جديد" : "توليد الخبر";
      saveDraft();
    }
  }

  function renderGenerated() {
    const n = state.news;
    const box = $("#genResult");
    if (!n) { box.hidden = true; $("#toReview").disabled = true; $("#regenerateBtn").hidden = true; $("#missingInfo").hidden = true; return; }
    $("#r_ar_title").textContent = n.ar_title;
    $("#r_ar_body").innerHTML = paragraphsHtml(n.ar_body);
    $("#r_en_title").textContent = n.en_title;
    $("#r_en_body").innerHTML = paragraphsHtml(n.en_body);
    box.hidden = false;
    $("#toReview").disabled = false;
    $("#regenerateBtn").hidden = false;
    $(".btn__text", $("#generateBtn")).textContent = "توليد من جديد";
    const mi = $("#missingInfo");
    if (n.missing_info?.length) {
      mi.innerHTML = `<strong>معلومات لم ترد في المدخلات ولم تُفترض:</strong><ul>${n.missing_info.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul><span class="muted">يمكنك إضافتها في مرحلة "معلومات الخبر" ثم إعادة التوليد، أو إدراجها يدويًا في مرحلة المراجعة.</span>`;
      mi.hidden = false;
    } else mi.hidden = true;
  }

  /* ---------------- المرحلة 4: المراجعة ---------------- */
  let syncTimer;
  function renderEditor() {
    const n = state.news;
    if (!n) return;
    $("#e_ar_title").value = n.ar_title;
    $("#e_ar_body").value = n.ar_body;
    $("#e_en_title").value = n.en_title;
    $("#e_en_body").value = n.en_body;
    updateCounts();
    $("#staleBadge").hidden = !state.enStale;
  }
  function updateCounts() {
    $("#arCount").textContent = `${wordCount($("#e_ar_body").value)} كلمة`;
    $("#enCount").textContent = `${wordCount($("#e_en_body").value)} words`;
  }
  function onArabicEdited() {
    const n = state.news;
    const t = $("#e_ar_title").value;
    const b = $("#e_ar_body").value;
    if (t === n.ar_title && b === n.ar_body) return;
    n.ar_title = t;
    n.ar_body = b;
    state.enStale = true;
    state.approved = false;
    $("#staleBadge").hidden = false;
    updateCounts();
    saveDraft();
    if ($("#autoSync").checked) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncTranslation, 1800);
    }
  }
  async function syncTranslation() {
    clearTimeout(syncTimer);
    const n = state.news;
    if (!n) return;
    n.ar_title = $("#e_ar_title").value;
    n.ar_body = $("#e_ar_body").value;
    if (!n.ar_title.trim() || !n.ar_body.trim()) { toast("العنوان أو النص العربي فارغ.", "error"); return; }
    const btn = $("#syncBtn");
    setLoading(btn, true);
    $(".btn__text", btn).textContent = "جارٍ تحديث الترجمة...";
    try {
      const r = await api("/api/translate", { ar_title: n.ar_title, ar_body: n.ar_body, prev_en_title: n.en_title, prev_en_body: n.en_body });
      n.en_title = r.en_title;
      n.en_body = r.en_body;
      state.enStale = false;
      $("#e_en_title").value = n.en_title;
      $("#e_en_body").value = n.en_body;
      $("#staleBadge").hidden = true;
      updateCounts();
      toast("تم تحديث الترجمة الإنجليزية.", "ok");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setLoading(btn, false);
      $(".btn__text", btn).textContent = "تحديث الترجمة الإنجليزية";
      saveDraft();
    }
  }
  function onEnglishEdited() {
    const n = state.news;
    n.en_title = $("#e_en_title").value;
    n.en_body = $("#e_en_body").value;
    state.approved = false;
    updateCounts();
    saveDraft();
  }

  /* ---------------- المرحلة 5: الاعتماد والتصدير ---------------- */
  function mainImage() {
    return state.images.find((i) => i.main) || state.images[0] || null;
  }
  function fileNames() {
    const base = safeFileName(state.news?.ar_title);
    return { ar: `${base} - AR.docx`, en: `${base} - EN.docx` };
  }
  function renderFinal() {
    const n = state.news;
    if (!n) return;
    const img = mainImage();
    const inc = $("#includeImage").checked && img;
    const meta = (lang) => {
      const rows = [];
      if (n.organizer) rows.push(`<strong>${lang === "ar" ? "الجهة المنظمة" : "Organizing Unit"}:</strong> ${escapeHtml(n.organizer)}`);
      if (n.event_date) rows.push(`<strong>${lang === "ar" ? "التاريخ" : "Date"}:</strong> ${escapeHtml(n.event_date)}`);
      return rows.length ? `<p class="muted">${rows.join(" &nbsp;|&nbsp; ")}</p>` : "";
    };
    const figure = (lang) =>
      inc
        ? `<figure style="margin:16px 0 0"><img src="${img.url}" alt="${escapeHtml(lang === "ar" ? img.altAr : img.altEn)}" style="max-width:100%;border-radius:8px;display:block"/><figcaption class="muted" style="margin-top:6px">${escapeHtml(lang === "ar" ? img.altAr : img.altEn) || (lang === "ar" ? "(لا يوجد نص بديل)" : "(no alt text)")}</figcaption></figure>`
        : "";
    $("#finalPreview").innerHTML = `
      <article class="news-card" dir="rtl">
        <div class="news-card__bar"><span>النسخة العربية النهائية</span><button class="btn btn--sm" data-copy="ar">نسخ</button></div>
        <h3>${escapeHtml(n.ar_title)}</h3>
        <div class="news-body">${meta("ar")}${paragraphsHtml(n.ar_body)}${figure("ar")}</div>
      </article>
      <article class="news-card news-card--en" dir="ltr">
        <div class="news-card__bar"><span>Final English Version</span><button class="btn btn--sm" data-copy="en">Copy</button></div>
        <h3>${escapeHtml(n.en_title)}</h3>
        <div class="news-body">${meta("en")}${paragraphsHtml(n.en_body)}${figure("en")}</div>
      </article>`;
    $("#finalPreview").classList.toggle("is-locked", state.approved);
    $("#approveBox").hidden = state.approved;
    $("#exportBox").hidden = !state.approved;
    const fn = fileNames();
    $("#fnAr").textContent = fn.ar;
    $("#fnEn").textContent = fn.en;
    const fsOk = "showDirectoryPicker" in window;
    $("#saveFolderBtn").hidden = !fsOk;
    $("#fsNote").textContent = fsOk
      ? "يمكنك اختيار المجلد مباشرة (Chrome/Edge)، أو تنزيل كل ملف على حدة إلى مجلد التنزيلات."
      : "المتصفح الحالي لا يدعم اختيار المجلد مباشرة؛ سيُحفظ كل ملف في مجلد التنزيلات أو حسب إعداد المتصفح.";
  }

  function exportPayload(lang) {
    const n = state.news;
    const img = mainImage();
    const inc = $("#includeImage").checked && img;
    return {
      lang,
      title: lang === "ar" ? n.ar_title : n.en_title,
      body: lang === "ar" ? n.ar_body : n.en_body,
      altText: inc ? (lang === "ar" ? img.altAr : img.altEn) : "",
      image: inc ? { type: img.type, data: img.data, width: img.width, height: img.height } : null,
    };
  }

  async function buildDoc(lang) {
    return apiBlob("/api/export", exportPayload(lang));
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function downloadOne(lang, btn) {
    if (!state.approved) return toast("اعتمد الخبر أولًا.", "error");
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "جارٍ إنشاء الملف...";
    try {
      const blob = await buildDoc(lang);
      download(blob, fileNames()[lang]);
      toast("تم إنشاء الملف.", "ok");
    } catch (e) {
      toast(e.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function saveToFolder() {
    if (!state.approved) return toast("اعتمد الخبر أولًا.", "error");
    const btn = $("#saveFolderBtn");
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: "readwrite" });
    } catch (e) {
      if (e.name !== "AbortError") toast("تعذر فتح المجلد.", "error");
      return;
    }
    setLoading(btn, true);
    $(".btn__text", btn).textContent = "جارٍ الحفظ...";
    try {
      const fn = fileNames();
      for (const lang of ["ar", "en"]) {
        const blob = await buildDoc(lang);
        const fh = await dir.getFileHandle(fn[lang], { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      }
      toast(`تم حفظ الملفين في مجلد "${dir.name}".`, "ok");
    } catch (e) {
      toast(`تعذر الحفظ: ${e.message}`, "error");
    } finally {
      setLoading(btn, false);
      $(".btn__text", btn).textContent = "اختيار مجلد وحفظ الملفين";
    }
  }

  function approve() {
    const n = state.news;
    if (!n?.ar_title.trim() || !n?.ar_body.trim() || !n?.en_title.trim() || !n?.en_body.trim()) return toast("لا يمكن اعتماد خبر ناقص.", "error");
    if (state.enStale) {
      if (!confirm("النسخة الإنجليزية لم تُحدَّث بعد آخر تعديل عربي. هل تريد الاعتماد على أي حال؟")) return;
    }
    state.approved = true;
    renderFinal();
    saveDraft();
    toast("تم اعتماد الخبر بنسختيه.", "ok");
  }

  function resetAll() {
    if (!confirm("سيتم مسح جميع البيانات والصور والنصوص. هل أنت متأكد؟")) return;
    state.input = {};
    state.images = [];
    state.news = null;
    state.enStale = false;
    state.approved = false;
    writeInputs();
    renderImages();
    renderGenerated();
    $(".btn__text", $("#generateBtn")).textContent = "توليد الخبر";
    localStorage.removeItem(STORAGE_KEY);
    goTo(1);
  }

  /* ---------------- الربط ---------------- */
  function bind() {
    $$(".step").forEach((s) => s.addEventListener("click", () => { readInputs(); goTo(Number(s.dataset.step)); }));
    $$("[data-next]").forEach((b) => b.addEventListener("click", () => { readInputs(); goTo(Number(b.dataset.next)); }));
    $$("[data-prev]").forEach((b) => b.addEventListener("click", () => goTo(Number(b.dataset.prev))));
    INPUT_FIELDS.forEach((k) => $("#" + k).addEventListener("input", readInputs));
    $("#clearAll").addEventListener("click", resetAll);
    $("#newNewsBtn").addEventListener("click", resetAll);

    bindImages();

    $("#generateBtn").addEventListener("click", () => generate(false));
    $("#regenerateBtn").addEventListener("click", () => generate(true));

    ["e_ar_title", "e_ar_body"].forEach((id) => $("#" + id).addEventListener("input", onArabicEdited));
    ["e_en_title", "e_en_body"].forEach((id) => $("#" + id).addEventListener("input", onEnglishEdited));
    $("#syncBtn").addEventListener("click", syncTranslation);

    $("#includeImage").addEventListener("change", renderFinal);
    $("#approveBtn").addEventListener("click", approve);
    $("#unapproveBtn").addEventListener("click", () => { state.approved = false; renderFinal(); saveDraft(); });
    $("#saveFolderBtn").addEventListener("click", saveToFolder);
    $("#dlArBtn").addEventListener("click", (e) => downloadOne("ar", e.currentTarget));
    $("#dlEnBtn").addEventListener("click", (e) => downloadOne("en", e.currentTarget));

    async function setupProvider(provider, key, btn, busyText, idleText) {
      setLoading(btn, true);
      $(".btn__text", btn).textContent = busyText;
      try {
        const r = await api("/api/setup", { provider, key });
        applyStatus({ provider: r.provider, ready: true });
        $("#keyInput").value = "";
        toast(`تم تفعيل ${providerLabel(r.provider)} بنجاح.`, "ok");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        setLoading(btn, false);
        $(".btn__text", btn).textContent = idleText;
      }
    }
    $("#useCopilotBtn").addEventListener("click", (e) =>
      setupProvider("copilot", null, e.currentTarget, "جارٍ الاتصال بـ Copilot...", "استخدام GitHub Copilot"),
    );
    $("#keyForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const key = $("#keyInput").value.trim();
      if (!key) return;
      setupProvider("anthropic", key, $("#keyForm .btn"), "جارٍ التحقق...", "حفظ المفتاح");
    });
    $("#changeProviderBtn").addEventListener("click", () => {
      $("#credBanner").hidden = false;
      $("#credDetail").textContent = "اختر مزوّدًا آخر أو أبقِ الحالي.";
      $("#credBanner").scrollIntoView({ behavior: "smooth" });
    });

    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b || !state.news) return;
      const n = state.news;
      if (b.dataset.copy === "ar") copyText(`${n.ar_title}\n\n${n.ar_body}`, "تم نسخ الخبر العربي.");
      else copyText(`${n.en_title}\n\n${n.en_body}`, "English version copied.");
    });
  }

  function providerLabel(p) {
    return p === "copilot" ? "GitHub Copilot" : "Claude (Anthropic)";
  }
  function applyStatus(s) {
    state.credentials = !!s.ready;
    $("#credBanner").hidden = state.credentials;
    $("#providerBar").hidden = !state.credentials;
    $("#providerName").textContent = providerLabel(s.provider);
    if (!state.credentials && s.detail) {
      $("#credDetail").textContent = s.provider === "copilot" ? `تعذر الاتصال بـ GitHub Copilot تلقائيًا: ${s.detail}` : "لم يُضبط مفتاح Claude بعد.";
    }
  }

  async function init() {
    loadDraft();
    writeInputs();
    renderImages();
    renderGenerated();
    bind();
    goTo(Math.min(state.step, state.news ? 5 : 3));
    try {
      applyStatus(await fetch("/api/status").then((r) => r.json()));
    } catch {
      applyStatus({ provider: "copilot", ready: false, detail: "الخادم لا يستجيب." });
    }
  }

  init();
})();
