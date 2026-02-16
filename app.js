// Quiz Immunologia - SPA vanilla JS
// Carica le domande da immunologia_v21_mcq.txt e renderizza Home/Quiz/Statistiche
// Nessun backend. Solo browser + localStorage.

const view = document.getElementById("view");

const STORAGE_KEY = "immunologia_quiz_v1";

const state = {
    all: [],
    categories: [],
    mode: "home", // home | quiz | stats | done
    config: { category: "Tutte", limit: 30, shuffle: true, wrongOnly: false },
    quiz: { items: [], index: 0, selected: new Set(), correct: 0, answered: 0, wrongIds: new Set() },
    stats: { played: 0, correct: 0, wrong: 0, perCategory: {} },
};

function save() {
    const payload = {
        config: state.config,
        stats: state.stats,
        wrongIds: Array.from(state.quiz.wrongIds),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
        const p = JSON.parse(raw);
        if (p.config) state.config = { ...state.config, ...p.config };
        if (p.stats) state.stats = p.stats;
        if (Array.isArray(p.wrongIds)) state.quiz.wrongIds = new Set(p.wrongIds);
    } catch {
        // ignora
    }
}

function resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function uniqCategories(questions) {
    const set = new Set();
    for (const q of questions) set.add(q.category || "Senza categoria");
    return ["Tutte", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
}

function isOptionLine(line) {
    return /^([A-Za-z0-9]+)\)\s*(.*)$/.test(line);
}

function parseOptionLine(line) {
    const m = line.match(/^([A-Za-z0-9]+)\)\s*(.*)$/);
    if (!m) return null;
    return { label: m[1], text: (m[2] ?? "").trim() };
}

function normalizeLabelForCompare(label) {
    const s = String(label).trim();
    if (!s) return "";
    return /^\d+$/.test(s) ? s : s.toUpperCase();
}

function splitAns(ansRaw) {
    const cleaned = String(ansRaw ?? "").trim();
    if (!cleaned || cleaned === "?") return [];
    return cleaned
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean);
}

function fnv1a32Hex(str) {
    // hash deterministico per avere ID stabile tra reload (wrongIds/statistiche)
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

function chooseAnswerRun(runs, correctLabels) {
    // runs: [{ idxs:[...], options:[{label,text}] }]
    if (!runs.length) return null;

    const normAns = correctLabels.map(normalizeLabelForCompare).filter(Boolean);
    const hasAns = normAns.length > 0;

    if (!hasAns) {
        // nessuna soluzione: prendi l'ultimo run con >=2 opzioni
        for (let i = runs.length - 1; i >= 0; i--) {
            if (runs[i].options.length >= 2) return runs[i];
        }
        return runs[runs.length - 1];
    }

    let best = null;
    let bestScore = -1;
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const runLabels = new Set(run.options.map((o) => normalizeLabelForCompare(o.label)));
        const containsAll = normAns.every((a) => runLabels.has(a));
        const intersection = normAns.reduce((acc, a) => acc + (runLabels.has(a) ? 1 : 0), 0);

        // preferisci run che contiene tutte le risposte, poi più vicino in basso
        const score = (containsAll ? 100 : 0) + intersection * 10 + i;
        if (score > bestScore) {
            best = run;
            bestScore = score;
        }
    }
    return best;
}

function parseTxtToQuestions(txt) {
    // separa i blocchi: una riga vuota prima di "CAT:"
    const blocks = txt
        .trim()
        .split(/\n\s*\n(?=CAT:)/g)
        .map((b) => b.trim())
        .filter(Boolean);

    const questions = [];
    for (const block of blocks) {
        const rawLines = block.split("\n").map((l) => l.trimEnd());
        const lines = rawLines.filter((l) => l.trim() !== "");

        const catLine = lines.find((l) => l.startsWith("CAT:"));
        const qLineIndex = lines.findIndex((l) => l.startsWith("Q:"));
        const ansLineIndex = lines.findIndex((l) => l.startsWith("ANS:"));

        if (!catLine || qLineIndex === -1 || ansLineIndex === -1) continue;

        const category = catLine.replace(/^CAT:\s*/, "").trim() || "Senza categoria";

        const ansRaw = lines[ansLineIndex].replace(/^ANS:\s*/, "").trim();
        const correctLabels = splitAns(ansRaw);

        // costruisci runs di option lines tra Q e ANS
        const runs = [];
        let current = null;

        for (let i = qLineIndex + 1; i < ansLineIndex; i++) {
            const l = lines[i];
            if (isOptionLine(l)) {
                const opt = parseOptionLine(l);
                if (!opt) continue;
                if (!current) current = { idxs: [], options: [] };
                current.idxs.push(i);
                current.options.push(opt);
            } else {
                if (current) {
                    runs.push(current);
                    current = null;
                }
            }
        }
        if (current) runs.push(current);

        const answerRun = chooseAnswerRun(runs, correctLabels);

        // testo domanda: Q: + tutte le righe tra Q e ANS che NON sono answer options
        const qFirst = lines[qLineIndex].replace(/^Q:\s*/, "").trim();
        const questionLines = [qFirst];

        const answerIdxSet = new Set(answerRun ? answerRun.idxs : []);
        for (let i = qLineIndex + 1; i < ansLineIndex; i++) {
            if (answerIdxSet.has(i)) continue;
            // include anche liste tipo 1) ... 2) ... (sequenze)
            questionLines.push(lines[i].trim());
        }

        const question = questionLines.join("\n").trim();

        const options = answerRun ? answerRun.options : [];
        if (options.length < 2) continue; // requisito: almeno 2 scelte

        const idSource =
            category +
            "|" +
            question +
            "|" +
            options.map((o) => `${o.label})${o.text}`).join("|");
        const id = fnv1a32Hex(idSource);

        questions.push({
            id,
            category,
            question,
            options, // ordine preservato
            correctLabels, // ordine preservato come in ANS
            hasAnswer: correctLabels.length > 0,
        });
    }

    return questions;
}

function wireNav() {
    document.getElementById("nav-home").onclick = () => renderHome();
    document.getElementById("nav-stats").onclick = () => renderStats();
    document.getElementById("nav-reset").onclick = () => resetAll();
}

function renderHome() {
    state.mode = "home";
    const total = state.all.length;

    const catsOptions = state.categories
        .map(
            (c) =>
                `<option value="${escapeHtml(c)}" ${
                    c === state.config.category ? "selected" : ""
                }>${escapeHtml(c)}</option>`
        )
        .join("");

    view.innerHTML = `
    <div class="card">
      <div class="row">
        <div>
          <div class="label">Domande disponibili</div>
          <div class="kpi">${total}</div>
        </div>
        <div>
          <div class="label">Sbagliate salvate</div>
          <div class="kpi">${state.quiz.wrongIds.size}</div>
        </div>
      </div>

      <hr />

      <div class="row">
        <label class="label">Categoria</label>
        <select id="cat" class="select">${catsOptions}</select>

        <label class="label">Numero domande</label>
        <input id="limit" type="number" min="1" max="${total}" value="${state.config.limit}" />

        <label class="label">
          <input id="shuffle" type="checkbox" ${state.config.shuffle ? "checked" : ""} />
          Mischia
        </label>

        <label class="label">
          <input id="wrongOnly" type="checkbox" ${state.config.wrongOnly ? "checked" : ""} />
          Solo sbagliate
        </label>

        <button id="start">Inizia</button>
      </div>

      <p class="muted">
        Nota: domande senza soluzione (ANS: ?) vengono mostrate ma non vengono conteggiate nelle statistiche.
      </p>
    </div>
  `;

    document.getElementById("start").onclick = () => {
        state.config.category = document.getElementById("cat").value;
        state.config.limit = Math.max(1, Number(document.getElementById("limit").value) || 30);
        state.config.shuffle = document.getElementById("shuffle").checked;
        state.config.wrongOnly = document.getElementById("wrongOnly").checked;
        save();
        startQuiz();
    };
}

function startQuiz() {
    let pool = [...state.all];

    if (state.config.category !== "Tutte") {
        pool = pool.filter((q) => q.category === state.config.category);
    }

    if (state.config.wrongOnly) {
        pool = pool.filter((q) => state.quiz.wrongIds.has(q.id));
    }

    if (state.config.shuffle) shuffle(pool);

    pool = pool.slice(0, Math.min(state.config.limit, pool.length));

    state.quiz.items = pool;
    state.quiz.index = 0;
    state.quiz.selected = new Set();
    state.quiz.correct = 0;
    state.quiz.answered = 0;

    renderQuiz();
}

function renderQuiz() {
    state.mode = "quiz";
    const q = state.quiz.items[state.quiz.index];
    if (!q) return renderDone();

    const multi = q.correctLabels.length > 1;
    const inputType = multi ? "checkbox" : "radio";

    const optionsHtml = q.options
        .map((o) => {
            const checked = state.quiz.selected.has(o.label) ? "checked" : "";
            return `
        <label class="option">
          <input type="${inputType}" name="opt" value="${escapeHtml(o.label)}" ${checked} />
          <div>
            <div><strong>${escapeHtml(o.label)})</strong> ${escapeHtml(o.text)}</div>
          </div>
        </label>
      `;
        })
        .join("");

    view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="label">Categoria: <strong>${escapeHtml(q.category)}</strong></div>
        <div class="label">Domanda ${state.quiz.index + 1} / ${state.quiz.items.length}</div>
      </div>

      <pre class="qtext">${escapeHtml(q.question)}</pre>

      <div id="options">${optionsHtml}</div>

      <div class="row">
        <button id="check">Conferma</button>
        <button id="skip">Salta</button>
        <button id="back">Indietro</button>
      </div>

      <p id="feedback" class="muted"></p>
    </div>
  `;

    document.querySelectorAll('input[name="opt"]').forEach((inp) => {
        inp.onchange = (e) => {
            const lab = e.target.value;
            if (multi) {
                if (e.target.checked) state.quiz.selected.add(lab);
                else state.quiz.selected.delete(lab);
            } else {
                state.quiz.selected = new Set([lab]);
            }
        };
    });

    document.getElementById("back").onclick = () => {
        if (state.quiz.index > 0) {
            state.quiz.index--;
            state.quiz.selected = new Set();
            renderQuiz();
        }
    };

    document.getElementById("skip").onclick = () => nextQuestion();

    document.getElementById("check").onclick = () => {
        if (!q.hasAnswer) {
            feedback("Soluzione non disponibile per questa domanda (ANS: ?). Non conteggiata.");
            setTimeout(() => nextQuestion(), 700);
            return;
        }

        const selected = Array.from(state.quiz.selected);
        const ok = sameSet(
            new Set(selected.map(normalizeLabelForCompare)),
            new Set(q.correctLabels.map(normalizeLabelForCompare))
        );

        state.stats.played++;
        state.stats.perCategory[q.category] ??= { played: 0, correct: 0, wrong: 0 };
        state.stats.perCategory[q.category].played++;

        if (ok) {
            state.quiz.correct++;
            state.stats.correct++;
            state.stats.perCategory[q.category].correct++;
            state.quiz.wrongIds.delete(q.id);
            feedback("Corretto.");
        } else {
            state.stats.wrong++;
            state.stats.perCategory[q.category].wrong++;
            state.quiz.wrongIds.add(q.id);
            feedback(`Sbagliato. Corrette: ${q.correctLabels.join(", ")}`);
        }

        state.quiz.answered++;
        save();

        setTimeout(() => nextQuestion(), 700);
    };
}

function feedback(msg) {
    const el = document.getElementById("feedback");
    if (el) el.textContent = msg;
}

function nextQuestion() {
    state.quiz.index++;
    state.quiz.selected = new Set();
    renderQuiz();
}

function renderDone() {
    state.mode = "done";
    const total = state.quiz.items.length || 0;
    const correct = state.quiz.correct;
    const pct = total ? Math.round((correct / total) * 100) : 0;

    view.innerHTML = `
    <div class="card">
      <h2>Finito</h2>
      <div class="row">
        <div>
          <div class="label">Corrette</div>
          <div class="kpi">${correct} / ${total}</div>
        </div>
        <div>
          <div class="label">Percentuale</div>
          <div class="kpi">${pct}%</div>
        </div>
      </div>
      <hr />
      <div class="row">
        <button id="again">Nuovo test</button>
        <button id="stats">Statistiche</button>
      </div>
    </div>
  `;

    document.getElementById("again").onclick = () => renderHome();
    document.getElementById("stats").onclick = () => renderStats();
}

function renderStats() {
    state.mode = "stats";

    const rows = Object.entries(state.stats.perCategory)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cat, s]) => {
            const pct = s.played ? Math.round((s.correct / s.played) * 100) : 0;
            return `<tr>
        <td>${escapeHtml(cat)}</td>
        <td>${s.played}</td>
        <td>${s.correct}</td>
        <td>${s.wrong}</td>
        <td>${pct}%</td>
      </tr>`;
        })
        .join("");

    view.innerHTML = `
    <div class="card">
      <h2>Statistiche</h2>
      <div class="row">
        <div>
          <div class="label">Giocate</div>
          <div class="kpi">${state.stats.played}</div>
        </div>
        <div>
          <div class="label">Corrette</div>
          <div class="kpi">${state.stats.correct}</div>
        </div>
        <div>
          <div class="label">Sbagliate</div>
          <div class="kpi">${state.stats.wrong}</div>
        </div>
      </div>

      <hr />

      <div class="card">
        <div class="label">Per categoria</div>
        <div style="overflow:auto;">
          <table class="tbl">
            <thead>
              <tr><th>Categoria</th><th>Giocate</th><th>Corrette</th><th>Sbagliate</th><th>%</th></tr>
            </thead>
            <tbody>${rows || "<tr><td colspan='5' class='muted'>Nessun dato.</td></tr>"}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function sameSet(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

function escapeHtml(str) {
    return String(str)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function init() {
    load();
    view.innerHTML = `<div class="card"><p>Caricamento domande…</p></div>`;

    try {
        const res = await fetch("./immunologia_v21_mcq.txt", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status} su ./immunologia_v21_mcq.txt`);

        const txt = await res.text();
        const questions = parseTxtToQuestions(txt);

        state.all = questions;
        state.categories = uniqCategories(state.all);

        wireNav();
        renderHome();
    } catch (err) {
        console.error(err);
        view.innerHTML = `
      <div class="card">
        <h2>Errore caricamento</h2>
        <p class="muted">${escapeHtml(String(err))}</p>
        <p class="muted">
          Cause tipiche: stai aprendo index.html in file:// (senza server) oppure il file immunologia_v21_mcq.txt
          non è nello stesso folder di index.html/app.js.
        </p>
      </div>
    `;
    }
}

init();
