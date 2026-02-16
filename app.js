const view = document.getElementById("view");

const STORAGE_KEY = "immunologia_v21_mcq.txt";
const state = {
    all: [],
    categories: [],
    mode: "home", // home | quiz | stats | done
    config: { category: "Tutte", limit: 30, shuffle: true, wrongOnly: false },
    quiz: { items: [], index: 0, selected: new Set(), correct: 0, answered: 0, wrongIds: new Set() },
    stats: { played: 0, correct: 0, wrong: 0, perCategory: {} }
};

function save() {
    const payload = {
        config: state.config,
        stats: state.stats,
        wrongIds: Array.from(state.quiz.wrongIds)
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
        if (p.wrongIds) state.quiz.wrongIds = new Set(p.wrongIds);
    } catch {}
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
    for (const q of questions) set.add(q.category ?? "Senza categoria");
    return ["Tutte", ...Array.from(set).sort((a,b) => a.localeCompare(b))];
}

function normalizeQuestion(q) {
    // atteso dal tuo JSON: { category, question, options:[{label,text}], correctLabels:[...] }
    return {
        id: q.id ?? crypto.randomUUID(),
        category: q.category ?? "Senza categoria",
        question: q.question ?? "",
        options: (q.options ?? []).map(o => ({ label: String(o.label), text: String(o.text) })),
        correctLabels: (q.correctLabels ?? []).map(x => String(x)) // può essere []
    };
}

async function init() {
    load();
    const res = await fetch("./data/questions.json", { cache: "no-store" });
    const data = await res.json();
    state.all = data.map(normalizeQuestion)
        // filtra: almeno 2 opzioni (come hai chiesto)
        .filter(q => q.options.length >= 2);

    state.categories = uniqCategories(state.all);

    wireNav();
    renderHome();
}

function wireNav() {
    document.getElementById("nav-home").onclick = () => renderHome();
    document.getElementById("nav-stats").onclick = () => renderStats();
    document.getElementById("nav-reset").onclick = () => resetAll();
}

function renderHome() {
    state.mode = "home";
    const total = state.all.length;
    const catsOptions = state.categories.map(c =>
        `<option value="${escapeHtml(c)}" ${c === state.config.category ? "selected" : ""}>${escapeHtml(c)}</option>`
    ).join("");

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
        Supporto multi-risposta: se una domanda ha più risposte corrette, compaiono checkbox. Se ne ha una sola, radio.
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
        pool = pool.filter(q => q.category === state.config.category);
    }

    if (state.config.wrongOnly) {
        pool = pool.filter(q => state.quiz.wrongIds.has(q.id));
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

    const multi = (q.correctLabels?.length ?? 0) > 1;
    const inputType = multi ? "checkbox" : "radio";

    // ordine opzioni preservato: non mischiamo qui.
    const optionsHtml = q.options.map(o => {
        const checked = state.quiz.selected.has(o.label) ? "checked" : "";
        return `
      <label class="option">
        <input type="${inputType}" name="opt" value="${escapeHtml(o.label)}" ${checked} />
        <div>
          <div><strong>${escapeHtml(o.label)})</strong> ${escapeHtml(o.text)}</div>
        </div>
      </label>
    `;
    }).join("");

    view.innerHTML = `
    <div class="card">
      <div class="row">
        <div class="label">Categoria: <strong>${escapeHtml(q.category)}</strong></div>
        <div class="label">Domanda ${state.quiz.index + 1} / ${state.quiz.items.length}</div>
      </div>

      <h2>${escapeHtml(q.question)}</h2>

      <div id="options">${optionsHtml}</div>

      <div class="row">
        <button id="check">Conferma</button>
        <button id="skip">Salta</button>
        <button id="back">Indietro</button>
      </div>

      <p id="feedback" class="muted"></p>
    </div>
  `;

    // selezione
    document.querySelectorAll('input[name="opt"]').forEach(inp => {
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

    document.getElementById("skip").onclick = () => nextQuestion(null);

    document.getElementById("check").onclick = () => {
        const selected = Array.from(state.quiz.selected);
        const correct = q.correctLabels ?? [];
        const ok = sameSet(new Set(selected), new Set(correct));

        // aggiorna statistiche
        state.stats.played++;
        state.stats.perCategory[q.category] ??= { played: 0, correct: 0, wrong: 0 };
        state.stats.perCategory[q.category].played++;

        if (ok) {
            state.quiz.correct++;
            state.stats.correct++;
            state.stats.perCategory[q.category].correct++;
            // se era in wrong list, la possiamo anche togliere (dipende: io la tolgo)
            state.quiz.wrongIds.delete(q.id);
            feedback(`Corretto.`);
        } else {
            state.stats.wrong++;
            state.stats.perCategory[q.category].wrong++;
            state.quiz.wrongIds.add(q.id);
            const corrTxt = correct.length ? correct.join(", ") : "(nessuna risposta marcata)";
            feedback(`Sbagliato. Corrette: ${corrTxt}`);
        }

        state.quiz.answered++;
        save();

        // vai avanti dopo un attimo, così lo leggi
        setTimeout(() => nextQuestion(ok), 650);
    };
}

function feedback(msg) {
    const el = document.getElementById("feedback");
    if (el) el.textContent = msg;
}

function nextQuestion(_) {
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
        .sort((a,b) => a[0].localeCompare(b[0]))
        .map(([cat, s]) => {
            const pct = s.played ? Math.round((s.correct / s.played) * 100) : 0;
            return `<tr>
        <td>${escapeHtml(cat)}</td>
        <td>${s.played}</td>
        <td>${s.correct}</td>
        <td>${s.wrong}</td>
        <td>${pct}%</td>
      </tr>`;
        }).join("");

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
          <table>
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

init();
