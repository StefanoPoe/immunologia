// Quiz Immunologia - SPA vanilla JS
// Modalità: Allenamento (una domanda per volta) + Simulazione esame (33 domande/30 min)

const view = document.getElementById("view");
// nuovo file domande (formato CAT/Q/R/ANS)
const QUESTIONS_FILE = "./quiz_immunologia_strutturato_CAT_Q_R_ANS.txt";

const STORAGE_KEY = "immunologia_quiz_v2";

// tempi (ms)
const PRACTICE_DELAY_OK = 900;
const PRACTICE_DELAY_WRONG = 2000;

// config esame
const EXAM_QUESTIONS = 33;
const EXAM_MINUTES = 30;

const state = {
    all: [],
    categories: [],
    mode: "home", // home | practice | done | stats | exam | exam_result
    config: { category: "Tutte", limit: 30, shuffle: true, mode: "practice", rangeEnabled: false, rangeFrom: 1, rangeTo: 1 },
    quiz: { items: [], index: 0, selected: new Set(), correct: 0, answered: 0 },
    stats: { played: 0, correct: 0, wrong: 0, perCategory: {} },

    exam: {
        items: [],
        answers: new Map(), // qid -> Set(labels)
        endAt: 0,
        timerId: null,
        submitted: false,
        results: null, // { total, correct, perQuestion: Map(qid -> {ok, correctLabels, selectedLabels}) }
    },
};

function save() {
    const payload = {
        config: state.config,
        stats: state.stats,
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

function clampInt(value, min, max) {
    let a = Number(min);
    let b = Number(max);
    if (!Number.isFinite(a)) a = 0;
    if (!Number.isFinite(b)) b = a;
    if (b < a) b = a;

    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return a;
    return Math.min(b, Math.max(a, n));
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
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("00000000" + h.toString(16)).slice(-8);
}

function chooseAnswerRun(runs, correctLabels) {
    if (!runs.length) return null;

    const normAns = correctLabels.map(normalizeLabelForCompare).filter(Boolean);
    const hasAns = normAns.length > 0;

    if (!hasAns) {
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

        const score = (containsAll ? 100 : 0) + intersection * 10 + i;
        if (score > bestScore) {
            best = run;
            bestScore = score;
        }
    }
    return best;
}

function isRLine(line) {
    // accetta "R:" anche con spazi tipo "R:   "
    return /^R:\s*$/.test(String(line || "").trim());
}

function parseTxtToQuestions(txt) {
    const blocks = txt
        .trim()
        .split(/\n\s*\n(?=CAT:)/g)
        .map((b) => b.trim())
        .filter(Boolean);

    const questions = [];
    for (const block of blocks) {
        // NB: non facciamo trim() a sinistra per non perdere l'indentazione,
        // ma usiamo trimEnd e poi gestiamo continuazioni con trim().
        const rawLines = block.split("\n").map((l) => l.trimEnd());
        const lines = rawLines.filter((l) => l.trim() !== "");

        const catLine = lines.find((l) => l.startsWith("CAT:"));
        const qLineIndex = lines.findIndex((l) => l.startsWith("Q:"));
        const ansLineIndex = lines.findIndex((l) => l.startsWith("ANS:"));

        if (!catLine || qLineIndex === -1 || ansLineIndex === -1) continue;

        const category = catLine.replace(/^CAT:\s*/, "").trim() || "Senza categoria";
        const ansRaw = lines[ansLineIndex].replace(/^ANS:\s*/, "").trim();
        const correctLabels = splitAns(ansRaw);

        // parse numero domanda dal Q: "123. testo..."
        const qRaw = lines[qLineIndex].replace(/^Q:\s*/, "").trim();
        let qNumber = null;
        let qFirstText = qRaw;
        const qm = qRaw.match(/^(\d+)\.\s*(.*)$/);
        if (qm) {
            qNumber = Number(qm[1]);
            qFirstText = (qm[2] ?? "").trim();
        }

        // se c’è "R:", separatore netto domanda/risposte
        const rLineIndex = lines.findIndex((l, idx) => idx > qLineIndex && idx < ansLineIndex && isRLine(l));

        let question = "";
        let options = [];

        if (rLineIndex !== -1) {
            // DOMANDA = da Q: fino a prima di R:
            const questionLines = [qFirstText];
            for (let i = qLineIndex + 1; i < rLineIndex; i++) {
                questionLines.push(lines[i].trim());
            }
            question = questionLines.join("\n").trim();

            // OPZIONI = da dopo R: fino a prima di ANS:
            // Se una riga non è una nuova opzione, è continuazione della precedente.
            const opts = [];
            let last = null;

            for (let i = rLineIndex + 1; i < ansLineIndex; i++) {
                const lRaw = lines[i];
                const l = lRaw.trim();

                if (!l) continue;

                if (isOptionLine(l)) {
                    const opt = parseOptionLine(l);
                    if (!opt) continue;
                    opts.push(opt);
                    last = opt;
                } else if (last) {
                    last.text = (last.text + "\n" + l).trim();
                }
            }

            options = opts;
        } else {
            // Fallback vecchio: runs
            const runs = [];
            let current = null;

            for (let i = qLineIndex + 1; i < ansLineIndex; i++) {
                const l = lines[i].trim();
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

            const questionLines = [qFirstText];
            const answerIdxSet = new Set(answerRun ? answerRun.idxs : []);
            for (let i = qLineIndex + 1; i < ansLineIndex; i++) {
                if (answerIdxSet.has(i)) continue;
                questionLines.push(lines[i].trim());
            }

            question = questionLines.join("\n").trim();
            options = answerRun ? answerRun.options : [];
        }

        if (options.length < 2) continue;

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
            qNumber,
            question,
            options,
            correctLabels,
            hasAnswer: correctLabels.length > 0,
        });
    }
    return questions;
}


function wireNav() {
    document.getElementById("nav-home").onclick = () => {
        stopExamTimer();
        renderHome();
    };
    document.getElementById("nav-stats").onclick = () => {
        stopExamTimer();
        renderStats();
    };
    document.getElementById("nav-reset").onclick = () => resetAll();
}

function renderHome() {
    state.mode = "home";
    const total = state.all.length;
    const maxQn = state.all.reduce((m, q) => Math.max(m, q.qNumber || 0), 0) || total;

    const isExam = state.config.mode === "exam";
    const isPractice = !isExam;
    const isAll = state.config.category === "Tutte";

    // visibilità controlli (come da specifica)
    const showCategory = isPractice;
    const showShuffle = isPractice;
    const showRangeToggle = isPractice && isAll;
    const showRangeInputs = showRangeToggle && state.config.rangeEnabled;
    const showLimit = isPractice;

    // normalizza range
    const rangeFromVal = clampInt(state.config.rangeFrom, 1, maxQn);
    const rangeToVal = clampInt(state.config.rangeTo, 1, maxQn);

    const catsOptions = state.categories
        .map(
            (c) =>
                `<option value="${escapeHtml(c)}" ${
                    c === state.config.category ? "selected" : ""
                }>${escapeHtml(c)}</option>`
        )
        .join("");

    const modeOptions = `
    <option value="practice" ${state.config.mode === "practice" ? "selected" : ""}>Allenamento</option>
    <option value="exam" ${state.config.mode === "exam" ? "selected" : ""}>Simulazione esame (33 domande / 30 min)</option>
  `;

    view.innerHTML = `
    <div class="card">
      <div class="row">
        <div>
          <div class="label">Domande disponibili</div>
          <div class="kpi">${total}</div>
        </div>
      </div>

      <hr />

      <div class="home-controls">
        <div class="home-line">
          <label class="label">Modalità</label>
          <select id="mode" class="select">${modeOptions}</select>
        </div>

        ${
        showCategory
            ? `
          <div class="home-line">
            <label class="label">Categoria</label>
            <select id="cat" class="select">${catsOptions}</select>
          </div>
        `
            : ""
    }

        ${
        showLimit
            ? `
          <div class="home-line">
            <label class="label">Numero domande</label>
            <input id="limit" type="number" min="1" max="${total}" value="${state.config.limit}" />
          </div>
        `
            : ""
    }

        ${
        showShuffle
            ? `
          <div class="home-line">
            <label class="label home-check">
              <input id="shuffle" type="checkbox" ${state.config.shuffle ? "checked" : ""} />
              Mischia
            </label>
          </div>
        `
            : ""
    }

        ${
        showRangeToggle
            ? `
          <div class="home-line">
            <label class="label home-check">
              <input id="rangeEnabled" type="checkbox" ${state.config.rangeEnabled ? "checked" : ""} />
              Range
            </label>

            ${
                showRangeInputs
                    ? `
              <label class="label">Da</label>
              <input id="rangeFrom" type="number" min="1" max="${maxQn}" value="${rangeFromVal}" />
              <label class="label">A</label>
              <input id="rangeTo" type="number" min="1" max="${maxQn}" value="${rangeToVal}" />
            `
                    : ""
            }
          </div>
        `
            : ""
    }

        <div class="home-line">
          <button id="start" class="primary">Inizia</button>
        </div>
      </div>

      <p class="muted">
        ${
        isExam
            ? "Simulazione: 33 domande in 30 minuti, tutte su una pagina."
            : isAll
                ? state.config.rangeEnabled
                    ? "Allenamento: scegli un range e quante domande estrarre da quel range (mischiabili)."
                    : "Allenamento: scegli quante domande fare (mischiabili)."
                : "Allenamento: una domanda per volta, con correzione immediata."
    }
      </p>
    </div>
  `;

    const modeEl = document.getElementById("mode");
    modeEl.onchange = (e) => {
        state.config.mode = e.target.value;

        if (state.config.mode === "exam") {
            state.config.category = "Tutte";
            state.config.rangeEnabled = false;
            state.config.shuffle = true;
        }
        save();
        renderHome();
    };

    const catEl = document.getElementById("cat");
    if (catEl) {
        catEl.onchange = (e) => {
            state.config.category = e.target.value;
            if (state.config.category !== "Tutte") state.config.rangeEnabled = false;
            save();
            renderHome();
        };
    }

    const rangeEnabledEl = document.getElementById("rangeEnabled");
    if (rangeEnabledEl) {
        rangeEnabledEl.onchange = () => {
            state.config.rangeEnabled = rangeEnabledEl.checked;
            save();
            renderHome();
        };
    }

    document.getElementById("start").onclick = () => {
        state.config.mode = document.getElementById("mode").value;

        if (state.config.mode === "exam") {
            state.config.category = "Tutte";
            state.config.rangeEnabled = false;
            state.config.shuffle = true;
            save();
            startExam();
            return;
        }

        const cat = document.getElementById("cat")?.value;
        if (cat) state.config.category = cat;

        const shuffleEl = document.getElementById("shuffle");
        if (shuffleEl) state.config.shuffle = shuffleEl.checked;

        const re = document.getElementById("rangeEnabled");
        state.config.rangeEnabled = re ? re.checked : false;

        if (state.config.category !== "Tutte") state.config.rangeEnabled = false;

        const rf = document.getElementById("rangeFrom");
        const rt = document.getElementById("rangeTo");
        if (rf && rt) {
            state.config.rangeFrom = clampInt(rf.value, 1, maxQn);
            state.config.rangeTo = clampInt(rt.value, 1, maxQn);
        }

        const limitEl = document.getElementById("limit");
        if (limitEl) state.config.limit = clampInt(limitEl.value, 1, total);

        save();
        startPractice();
    };
}

function startPractice() {
    let pool = [...state.all];

    if (state.config.category !== "Tutte") {
        pool = pool.filter((q) => q.category === state.config.category);
    }

    // range (solo allenamento): filtra per numero domanda del DOCX (Q: N.)
    if (state.config.rangeEnabled) {
        let a = Math.max(1, Number(state.config.rangeFrom) || 1);
        let b = Math.max(1, Number(state.config.rangeTo) || a);
        if (b < a) [a, b] = [b, a];
        pool = pool.filter((q) => typeof q.qNumber === "number" && q.qNumber >= a && q.qNumber <= b);
    }

    if (state.config.shuffle) shuffle(pool);

    
    pool = pool.slice(0, Math.min(state.config.limit, pool.length));


    state.quiz.items = pool;
    state.quiz.index = 0;
    state.quiz.selected = new Set();
    state.quiz.correct = 0;
    state.quiz.answered = 0;

    renderPractice();
}

function selectionHint(q) {
    if (!q.hasAnswer) return "Soluzione non disponibile per questa domanda.";
    const n = q.correctLabels.length;
    if (n === 1) return "Seleziona 1 risposta corretta.";
    return `Seleziona ${n} risposte corrette.`;
}

function applyPracticeHighlight(q, selectedSet, correctSet) {
    const labels = Array.from(document.querySelectorAll(".option[data-label]"));
    for (const el of labels) {
        const lab = el.dataset.label;
        const nl = normalizeLabelForCompare(lab);
        const isCorrect = correctSet.has(nl);
        const isSelected = selectedSet.has(nl);

        el.classList.remove("correct", "wrong", "missed", "chosen");

        if (isCorrect) el.classList.add("correct");
        if (isCorrect && !isSelected) el.classList.add("missed");

        if (isSelected) el.classList.add("chosen");
        if (isSelected && !isCorrect) el.classList.add("wrong");
    }
}

function renderPractice() {
    state.mode = "practice";
    const q = state.quiz.items[state.quiz.index];
    if (!q) return renderDonePractice();

    const multi = q.correctLabels.length > 1;
    const inputType = multi ? "checkbox" : "radio";
    const qDisplayText = (q.qNumber ? `${q.qNumber}. ` : "") + q.question;

    const optionsHtml = q.options
        .map((o) => {
            const checked = state.quiz.selected.has(o.label) ? "checked" : "";
            return `
        <label class="option" data-label="${escapeHtml(o.label)}">
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

      <pre class="qtext">${escapeHtml(qDisplayText)}</pre>

      <div class="hint">${escapeHtml(selectionHint(q))}</div>

      <div id="options">${optionsHtml}</div>

      <div class="row">
        <button id="check" class="primary">Conferma</button>
        <button id="skip">Salta</button>
        <button id="back">Indietro</button>
      </div>

      <p id="feedback" class="muted"></p>
    </div>
  `;

    let locked = false;

    document.querySelectorAll('input[name="opt"]').forEach((inp) => {
        inp.onchange = (e) => {
            if (locked) return;
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
        if (locked) return;
        if (state.quiz.index > 0) {
            state.quiz.index--;
            state.quiz.selected = new Set();
            renderPractice();
        }
    };

    document.getElementById("skip").onclick = () => {
        if (locked) return;
        nextPractice();
    };

    document.getElementById("check").onclick = () => {
        if (locked) return;
        locked = true;

        // blocca input
        document.querySelectorAll('input[name="opt"]').forEach((i) => (i.disabled = true));

        if (!q.hasAnswer) {
            feedback("Soluzione non disponibile (ANS: ?). Non conteggiata.");
            setTimeout(() => nextPractice(), PRACTICE_DELAY_OK);
            return;
        }

        const selectedNorm = new Set(Array.from(state.quiz.selected).map(normalizeLabelForCompare));
        const correctNorm = new Set(q.correctLabels.map(normalizeLabelForCompare));

        const ok = sameSet(selectedNorm, correctNorm);

        // evidenziazione
        applyPracticeHighlight(q, selectedNorm, correctNorm);

        // stats
        state.stats.played++;
        state.stats.perCategory[q.category] ??= { played: 0, correct: 0, wrong: 0 };
        state.stats.perCategory[q.category].played++;

        if (ok) {
            state.quiz.correct++;
            state.stats.correct++;
            state.stats.perCategory[q.category].correct++;
            feedback("Corretto.");
        } else {
            state.stats.wrong++;
            state.stats.perCategory[q.category].wrong++;
            feedback(`Sbagliato. Corrette: ${q.correctLabels.join(", ")}`);
        }

        state.quiz.answered++;
        save();

        setTimeout(() => nextPractice(), ok ? PRACTICE_DELAY_OK : PRACTICE_DELAY_WRONG);
    };
}

function feedback(msg) {
    const el = document.getElementById("feedback");
    if (el) el.textContent = msg;
}

function nextPractice() {
    state.quiz.index++;
    state.quiz.selected = new Set();
    renderPractice();
}

function renderDonePractice() {
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
        <button id="again" class="primary">Nuovo test</button>
        <button id="stats">Statistiche</button>
      </div>
    </div>
  `;

    document.getElementById("again").onclick = () => renderHome();
    document.getElementById("stats").onclick = () => renderStats();
}

/* =========================
   ESAME (33 domande / 30 min)
   ========================= */

function stopExamTimer() {
    if (state.exam.timerId) {
        clearInterval(state.exam.timerId);
        state.exam.timerId = null;
    }
}

function formatMMSS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
}

function startExam() {
    stopExamTimer();

    // pool: solo domande con soluzione
    let pool = state.all.filter((q) => q.hasAnswer);

    // simulazione esame = tutte le categorie, quindi ignora state.config.category
    if (state.config.shuffle) shuffle(pool);

    pool = pool.slice(0, Math.min(EXAM_QUESTIONS, pool.length));

    state.exam.items = pool;
    state.exam.answers = new Map();
    state.exam.submitted = false;
    state.exam.results = null;

    state.exam.endAt = Date.now() + EXAM_MINUTES * 60 * 1000;

    renderExam();

    state.exam.timerId = setInterval(() => {
        const left = state.exam.endAt - Date.now();
        const timerEl = document.getElementById("exam-timer");
        if (timerEl) timerEl.textContent = formatMMSS(left);

        if (left <= 0 && !state.exam.submitted) {
            submitExam(true);
        }
    }, 250);
}

function getExamAnsweredCount() {
    let n = 0;
    for (const q of state.exam.items) {
        const set = state.exam.answers.get(q.id);
        if (set && set.size > 0) n++;
    }
    return n;
}

function renderExam() {
    state.mode = "exam";

    const left = state.exam.endAt - Date.now();
    const answered = getExamAnsweredCount();

    const listHtml = state.exam.items
        .map((q, idx) => {
            const multi = q.correctLabels.length > 1;
            const inputType = multi ? "checkbox" : "radio";
            const current = state.exam.answers.get(q.id) ?? new Set();

            const optionsHtml = q.options
                .map((o) => {
                    const checked = current.has(o.label) ? "checked" : "";
                    return `
            <label class="option" data-qid="${escapeHtml(q.id)}" data-label="${escapeHtml(o.label)}">
              <input type="${inputType}" name="q_${escapeHtml(q.id)}" value="${escapeHtml(o.label)}" ${checked} />
              <div><strong>${escapeHtml(o.label)})</strong> ${escapeHtml(o.text)}</div>
            </label>
          `;
                })
                .join("");

            return `
        <div class="card" data-qcard="${escapeHtml(q.id)}">
          <div class="row">
            <div class="label"><strong>${idx + 1}</strong> · ${escapeHtml(q.category)}</div>
            <div class="label">${escapeHtml(selectionHint(q))}</div>
          </div>
          <pre class="qtext">${escapeHtml(q.question)}</pre>
          <div>${optionsHtml}</div>
        </div>
      `;
        })
        .join("");

    view.innerHTML = `
    <div class="card">
      <div class="timerbar">
        <div class="label">Simulazione esame: <strong>${EXAM_QUESTIONS}</strong> domande · <strong>${EXAM_MINUTES}</strong> minuti</div>
        <div class="timer">Tempo: <span id="exam-timer">${formatMMSS(left)}</span></div>
        <div class="label">Risposte date: <strong id="answered-count">${answered}</strong> / ${state.exam.items.length}</div>
      </div>
      <div class="row">
        <button id="submit-exam" class="primary">Consegna</button>
      </div>
      <p class="muted">Le domande sono tutte in pagina. Alla consegna vedi correzione completa (verde/rosso) e la risposta giusta.</p>
    </div>

    ${listHtml}
  `;

    // gestisci selezioni
    view.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach((inp) => {
        inp.onchange = (e) => {
            if (state.exam.submitted) return;

            const qid = e.target.name.replace(/^q_/, "");
            const q = state.exam.items.find((x) => x.id === qid);
            if (!q) return;

            const multi = q.correctLabels.length > 1;
            const value = e.target.value;

            if (!state.exam.answers.has(qid)) state.exam.answers.set(qid, new Set());
            const set = state.exam.answers.get(qid);

            if (multi) {
                if (e.target.checked) set.add(value);
                else set.delete(value);
            } else {
                // radio: reset e setta uno
                set.clear();
                set.add(value);
            }

            const answered = getExamAnsweredCount();
            const el = document.getElementById("answered-count");
            if (el) el.textContent = String(answered);
        };
    });

    document.getElementById("submit-exam").onclick = () => submitExam(false);
}

function submitExam(auto) {
    if (state.exam.submitted) return;
    state.exam.submitted = true;
    stopExamTimer();

    const perQuestion = new Map();
    let correct = 0;

    for (const q of state.exam.items) {
        const selectedRaw = state.exam.answers.get(q.id) ?? new Set();
        const selected = new Set(Array.from(selectedRaw).map(normalizeLabelForCompare));
        const correctSet = new Set(q.correctLabels.map(normalizeLabelForCompare));

        const ok = sameSet(selected, correctSet);
        if (ok) correct++;

        perQuestion.set(q.id, {
            ok,
            selectedLabels: new Set(Array.from(selectedRaw)),
            correctLabels: new Set(q.correctLabels),
        });
    }

    state.exam.results = { total: state.exam.items.length, correct, perQuestion };

    renderExamResults(auto);
}

function renderExamResults(auto) {
    state.mode = "exam_result";

    const total = state.exam.results.total;
    const correct = state.exam.results.correct;
    const pct = total ? Math.round((correct / total) * 100) : 0;

    // applica classi di evidenziazione a tutte le opzioni
    // (dopo aver renderizzato la stessa lista)
    const left = state.exam.endAt - Date.now();

    const listHtml = state.exam.items
        .map((q, idx) => {
            const res = state.exam.results.perQuestion.get(q.id);
            const selected = new Set(Array.from(res.selectedLabels).map(normalizeLabelForCompare));
            const correctSet = new Set(Array.from(res.correctLabels).map(normalizeLabelForCompare));

            const multi = q.correctLabels.length > 1;
            const inputType = multi ? "checkbox" : "radio";

            const optionsHtml = q.options
                .map((o) => {
                    const nl = normalizeLabelForCompare(o.label);
                    const isSelected = selected.has(nl);
                    const isCorrect = correctSet.has(nl);

                    let cls = "option";
                    if (isCorrect) cls += " correct";
                    if (isCorrect && !isSelected) cls += " missed";
                    if (isSelected) cls += " chosen";
                    if (isSelected && !isCorrect) cls += " wrong";

                    return `
            <label class="${cls}" data-label="${escapeHtml(o.label)}">
              <input type="${inputType}" disabled ${isSelected ? "checked" : ""} />
              <div><strong>${escapeHtml(o.label)})</strong> ${escapeHtml(o.text)}</div>
            </label>
          `;
                })
                .join("");

            return `
        <div class="card">
          <div class="row">
            <div class="label"><strong>${idx + 1}</strong> · ${escapeHtml(q.category)}</div>
            <div class="label">${res.ok ? "✅ Corretta" : "❌ Sbagliata"}</strong></div>
          </div>
          <pre class="qtext">${escapeHtml(q.question)}</pre>
          <div>${optionsHtml}</div>
        </div>
      `;
        })
        .join("");

    view.innerHTML = `
    <div class="card">
      <h2>Risultato simulazione</h2>
      <div class="row">
        <div>
          <div class="label">Corrette</div>
          <div class="kpi">${correct} / ${total}</div>
        </div>
        <div>
          <div class="label">Percentuale</div>
          <div class="kpi">${pct}%</div>
        </div>
        <div class="muted">${auto ? "Tempo scaduto: consegna automatica." : ""}</div>
      </div>
      <hr />
      <div class="row">
        <button id="back-home" class="primary">Home</button>
        <button id="stats">Statistiche</button>
      </div>
    </div>

    ${listHtml}
  `;

    document.getElementById("back-home").onclick = () => renderHome();
    document.getElementById("stats").onclick = () => renderStats();
}

/* =========================
   STATS
   ========================= */

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
        const res = await fetch(QUESTIONS_FILE, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status} su ${QUESTIONS_FILE}`);

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
          Se sei in locale: usa un server (python -m http.server). Su Pages: controlla che immunologia_v21_mcq2.txt sia nello stesso folder di index.html.
        </p>
      </div>
    `;
    }
}

init();
