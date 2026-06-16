// app.js

import { auth, db, provider } from "./firebase.config.js";

import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

const TEAM = {
  alek: {
    label: "Alek",
    email: "alekcaballeromusic@gmail.com"
  },
  cata: {
    label: "Cata",
    email: "catalina.medina.leal@gmail.com"
  }
};

// Modo Agente: endpoint de la Cloud Function y página de importación.
const AGENT_CONFIG = {
  functionUrl: "https://agentimportrentaloptions-icjdq4tq3a-uc.a.run.app",
  importPageUrl: "https://musicala.github.io/arriendosmusicala/agent-import.html",
  tokenDays: 7
};

// Plantilla del prompt. {{ENDPOINT}}, {{KEY}} e {{IMPORT_URL}} se rellenan al generar la clave.
const AGENT_PROMPT_TEMPLATE = `ROL
Eres un asistente de investigación inmobiliaria para "Musicala", una escuela de
artes (música, danza, artes plásticas y teatro) que busca un local en arriendo
en Bogotá. Buscas opciones reales de arriendo en internet y las entregas en JSON limpio.

OBJETIVO DEL ESPACIO
- Uso: escuela de artes con salones para música, danza, artes plásticas y teatro.
- Necesita varios salones/espacios y baños.
- Zonas preferidas: Pasadena, Pontevedra y Andes (ajustar si te indican otras).
- Presupuesto de canon: hasta $7.000.000 COP/mes.
- Verificar uso de suelo compatible con actividad educativa/cultural.

DÓNDE BUSCAR
Metrocuadrado, Fincaraíz, Ciencuadras, Mercado Libre Inmuebles, Properati e
inmobiliarias. Solo anuncios reales y vigentes.

REGLAS ESTRICTAS DE DATOS
1. NUNCA inventes datos. Si un dato no aparece, déjalo vacío ("") o en 0. No aproximes.
2. "listingUrl" debe ser el enlace real y directo al anuncio. Es obligatorio.
3. Precios en números sin símbolos ni puntos de miles (6500000, no "$6.500.000").
4. "agentConfidence": "alta" si el anuncio es claro, "media" si faltan datos, "baja" si es dudoso.
5. En "agentSummary" resume en 1-2 frases por qué sirve o no para una escuela de artes.
6. En "risks" marca riesgos reales (ej. "uso de suelo por verificar", "sin parqueadero").

FORMATO DE SALIDA (entrega SOLO este JSON, sin texto extra):
{
  "items": [
    {
      "title": "", "zone": "", "address": "",
      "rent": 0, "administration": 0, "area": 0,
      "rooms": 0, "bathrooms": 0, "parking": 0,
      "contactName": "", "contactPhone": "", "listingUrl": "",
      "status": "nueva", "pros": "", "cons": "",
      "risks": [], "tags": [], "agentSummary": "", "agentConfidence": "media"
    }
  ]
}

CÓMO ENTREGAR (con acceso a navegador):
1. Ve a la página de importación: {{IMPORT_URL}}
2. En "Endpoint" pega: {{ENDPOINT}}
3. En "Clave temporal del agente" pega: {{KEY}}
4. Pega el JSON completo en el área de texto.
5. Marca "Solo validar, no guardar" y presiona Importar para revisar la vista previa.
6. Si todo se ve bien, desmarca esa casilla e importa de verdad.
7. No guardes la clave en ningún otro lugar. Esta clave caduca en {{DAYS}} días.`;

const STATUS_LABELS = {
  nueva: "Nueva",
  por_contactar: "Por contactar",
  agendada: "Visita agendada",
  visitada: "Visitada",
  favorita: "Favorita",
  descartada: "Descartada"
};

const STATUS_OPTIONS = Object.entries(STATUS_LABELS);

const CRITERIA = [
  {
    key: "location",
    label: "Ubicación",
    help: "Zona, cercanía, visibilidad y sentido estratégico.",
    weight: 1.35
  },
  {
    key: "cost",
    label: "Costo",
    help: "Canon, administración, servicios y esfuerzo financiero.",
    weight: 1.45
  },
  {
    key: "space",
    label: "Espacio",
    help: "Área útil, cantidad de salones y posibilidad de circulación.",
    weight: 1.15
  },
  {
    key: "layout",
    label: "Distribución",
    help: "Qué tan fácil sería convertirlo en una escuela funcional.",
    weight: 1.15
  },
  {
    key: "sound",
    label: "Sonido y ruido",
    help: "Viabilidad para música, danza y clases sin guerra vecinal.",
    weight: 1.3
  },
  {
    key: "access",
    label: "Acceso",
    help: "Transporte, parqueo, llegada de estudiantes y familias.",
    weight: 1
  },
  {
    key: "safety",
    label: "Seguridad",
    help: "Percepción del sector, entrada/salida y tranquilidad.",
    weight: 1.05
  },
  {
    key: "permits",
    label: "Uso y permisos",
    help: "Posibilidad real de operar actividad educativa/cultural.",
    weight: 1.5
  },
  {
    key: "adaptability",
    label: "Adaptabilidad",
    help: "Adecuaciones, crecimiento y flexibilidad del lugar.",
    weight: 1.1
  },
  {
    key: "feeling",
    label: "Sensación",
    help: "La intuición también trabaja, aunque Recursos Humanos jamás la entienda.",
    weight: 0.8
  }
];

const state = {
  user: null,
  profile: null,
  options: [],
  filters: {
    search: "",
    status: "all",
    budget: "",
    score: "",
    sort: "score_desc"
  }
};

const els = {
  privateApp: document.querySelector("#privateApp"),
  blockedState: document.querySelector("#blockedState"),
  loginBtn: document.querySelector("#loginBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  authStatus: document.querySelector("#authStatus"),
  userBox: document.querySelector("#userBox"),
  newOptionBtn: document.querySelector("#newOptionBtn"),
  optionsGrid: document.querySelector("#optionsGrid"),
  emptyState: document.querySelector("#emptyState"),
  template: document.querySelector("#optionCardTemplate"),
  optionDialog: document.querySelector("#optionDialog"),
  optionForm: document.querySelector("#optionForm"),
  optionDialogTitle: document.querySelector("#optionDialogTitle"),
  ratingDialog: document.querySelector("#ratingDialog"),
  ratingForm: document.querySelector("#ratingForm"),
  ratingDialogTitle: document.querySelector("#ratingDialogTitle"),
  ratingUserLabel: document.querySelector("#ratingUserLabel"),
  ratingCriteria: document.querySelector("#ratingCriteria"),
  searchInput: document.querySelector("#searchInput"),
  statusFilter: document.querySelector("#statusFilter"),
  budgetFilter: document.querySelector("#budgetFilter"),
  scoreFilter: document.querySelector("#scoreFilter"),
  sortFilter: document.querySelector("#sortFilter"),
  metricActive: document.querySelector("#metricActive"),
  metricFavorites: document.querySelector("#metricFavorites"),
  metricBest: document.querySelector("#metricBest"),
  metricAvgRent: document.querySelector("#metricAvgRent"),
  agentModeBtn: document.querySelector("#agentModeBtn"),
  agentDialog: document.querySelector("#agentDialog"),
  agentTokenLabel: document.querySelector("#agentTokenLabel"),
  generateTokenBtn: document.querySelector("#generateTokenBtn"),
  newTokenBox: document.querySelector("#newTokenBox"),
  agentPromptOutput: document.querySelector("#agentPromptOutput"),
  copyPromptBtn: document.querySelector("#copyPromptBtn"),
  tokenList: document.querySelector("#tokenList")
};

const optionInputs = {
  id: document.querySelector("#optionId"),
  title: document.querySelector("#titleInput"),
  status: document.querySelector("#statusInput"),
  zone: document.querySelector("#zoneInput"),
  address: document.querySelector("#addressInput"),
  rent: document.querySelector("#rentInput"),
  administration: document.querySelector("#adminInput"),
  servicesEstimate: document.querySelector("#servicesInput"),
  setupEstimate: document.querySelector("#setupInput"),
  area: document.querySelector("#areaInput"),
  rooms: document.querySelector("#roomsInput"),
  bathrooms: document.querySelector("#bathroomsInput"),
  visitDate: document.querySelector("#visitDateInput"),
  nextActionDate: document.querySelector("#nextActionDateInput"),
  nextAction: document.querySelector("#nextActionInput"),
  contactName: document.querySelector("#contactNameInput"),
  contactPhone: document.querySelector("#contactPhoneInput"),
  listingUrl: document.querySelector("#listingUrlInput"),
  tags: document.querySelector("#tagsInput"),
  risks: document.querySelector("#risksInput"),
  pros: document.querySelector("#prosInput"),
  cons: document.querySelector("#consInput"),
  notes: document.querySelector("#notesInput"),
  favorite: document.querySelector("#favoriteInput")
};

init();

function init() {
  populateStatusSelects();
  bindEvents();
  renderRatingCriteria();

  onAuthStateChanged(auth, (user) => {
    state.user = user;
    state.profile = getProfileFromUser(user);
    renderAuth();

    if (state.profile) {
      subscribeToOptions();
    } else {
      stopOptionsSubscription();
      state.options = [];
      render();
    }
  });
}

function bindEvents() {
  els.loginBtn.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Error iniciando sesion:", error);
      alert("No se pudo iniciar sesion con Google.");
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Error cerrando sesion:", error);
      alert("No se pudo cerrar la sesion.");
    }
  });

  els.newOptionBtn.addEventListener("click", () => openOptionDialog());

  els.agentModeBtn.addEventListener("click", openAgentDialog);
  els.generateTokenBtn.addEventListener("click", handleGenerateToken);
  els.copyPromptBtn.addEventListener("click", copyAgentPrompt);

  els.optionForm.addEventListener("submit", handleOptionSubmit);
  els.ratingForm.addEventListener("submit", handleRatingSubmit);

  document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dialog = document.querySelector(`#${btn.dataset.closeDialog}`);
      dialog.close();
    });
  });

  els.searchInput.addEventListener("input", () => {
    state.filters.search = els.searchInput.value.trim().toLowerCase();
    render();
  });

  els.statusFilter.addEventListener("change", () => {
    state.filters.status = els.statusFilter.value;
    render();
  });

  els.budgetFilter.addEventListener("input", () => {
    state.filters.budget = els.budgetFilter.value;
    render();
  });

  els.scoreFilter.addEventListener("input", () => {
    state.filters.score = els.scoreFilter.value;
    render();
  });

  els.sortFilter.addEventListener("change", () => {
    state.filters.sort = els.sortFilter.value;
    render();
  });
}

function populateStatusSelects() {
  els.statusFilter.replaceChildren(
    createOption("all", "Todos"),
    ...STATUS_OPTIONS.map(([value, label]) => createOption(value, label))
  );

  optionInputs.status.replaceChildren(
    ...STATUS_OPTIONS.map(([value, label]) => createOption(value, label))
  );
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function getProfileFromUser(user) {
  if (!user?.email) return null;

  const email = user.email.toLowerCase();
  const entry = Object.entries(TEAM).find(([, profile]) => profile.email.toLowerCase() === email);

  if (!entry) return null;

  return {
    key: entry[0],
    ...entry[1]
  };
}

function renderAuth() {
  const user = state.user;
  const profile = state.profile;

  if (!user) {
    els.authStatus.textContent = "Sin iniciar sesión";
    els.userBox.classList.remove("is-online");
    els.loginBtn.classList.remove("hidden");
    els.logoutBtn.classList.add("hidden");
    els.agentModeBtn.classList.add("hidden");
    els.privateApp.classList.add("hidden");
    els.blockedState.classList.add("hidden");
    return;
  }

  els.loginBtn.classList.add("hidden");
  els.logoutBtn.classList.remove("hidden");
  els.userBox.classList.add("is-online");

  if (!profile) {
    els.authStatus.textContent = `${user.email} · sin acceso`;
    els.agentModeBtn.classList.add("hidden");
    els.privateApp.classList.add("hidden");
    els.blockedState.classList.remove("hidden");
    return;
  }

  els.agentModeBtn.classList.remove("hidden");

  els.authStatus.textContent = `${profile.label} · ${user.email}`;
  els.privateApp.classList.remove("hidden");
  els.blockedState.classList.add("hidden");
}

let unsubscribeOptions = null;

function stopOptionsSubscription() {
  if (!unsubscribeOptions) return;
  unsubscribeOptions();
  unsubscribeOptions = null;
}

function subscribeToOptions() {
  stopOptionsSubscription();

  const q = query(collection(db, "rentalOptions"), orderBy("updatedAt", "desc"));

  unsubscribeOptions = onSnapshot(q, (snapshot) => {
    state.options = snapshot.docs.map((item) => ({
      id: item.id,
      ...item.data()
    }));

    render();
  }, (error) => {
    console.error("Error escuchando opciones:", error);
    alert("No se pudieron cargar las opciones. Revisa reglas de Firestore y conexión.");
  });
}

function render() {
  if (!state.profile) {
    els.optionsGrid.innerHTML = "";
    return;
  }

  const visibleOptions = getVisibleOptions();

  renderMetrics();
  els.optionsGrid.innerHTML = "";
  els.emptyState.classList.toggle("hidden", state.options.length !== 0);

  visibleOptions.forEach((option) => {
    els.optionsGrid.appendChild(renderOptionCard(option));
  });
}

function renderMetrics() {
  const active = state.options.filter((option) => option.status !== "descartada").length;
  const favorites = state.options.filter((option) => option.favorite || option.status === "favorita").length;
  const scored = state.options.map((option) => getAverageScore(option)).filter((score) => score !== null);
  const best = scored.length ? Math.max(...scored) : null;
  const rents = state.options.map(getMonthlyCost).filter((value) => value > 0);
  const avgRent = rents.length ? rents.reduce((sum, value) => sum + value, 0) / rents.length : 0;

  els.metricActive.textContent = active;
  els.metricFavorites.textContent = favorites;
  els.metricBest.textContent = best === null ? "—" : `${Math.round(best)}/100`;
  els.metricAvgRent.textContent = avgRent ? formatCOP(avgRent) : "—";
}

function getVisibleOptions() {
  const search = state.filters.search;
  const maxBudget = numberOrNull(state.filters.budget);
  const minScore = numberOrNull(state.filters.score);

  const filtered = state.options.filter((option) => {
    const score = getAverageScore(option);
    const totalCost = getMonthlyCost(option);

    const blob = [
      option.title,
      option.zone,
      option.address,
      option.contactName,
      option.notes,
      option.pros,
      option.cons,
      option.bathrooms ? `${option.bathrooms} baños` : "",
      ...(option.tags || []),
      ...(option.risks || [])
    ].join(" ").toLowerCase();

    const matchesSearch = !search || blob.includes(search);
    const matchesStatus = state.filters.status === "all"
      || option.status === state.filters.status
      || (state.filters.status === "favorita" && option.favorite);
    const matchesBudget = !maxBudget || totalCost <= maxBudget;
    const matchesScore = !minScore || (score !== null && score >= minScore);

    return matchesSearch && matchesStatus && matchesBudget && matchesScore;
  });

  filtered.sort((a, b) => {
    if (state.filters.sort === "rent_asc") return getMonthlyCost(a) - getMonthlyCost(b);
    if (state.filters.sort === "area_desc") return safeNumber(b.area) - safeNumber(a.area);
    if (state.filters.sort === "created_desc") return getMillis(b.createdAt) - getMillis(a.createdAt);
    if (state.filters.sort === "updated_desc") return getMillis(b.updatedAt) - getMillis(a.updatedAt);

    return (getAverageScore(b) ?? -1) - (getAverageScore(a) ?? -1);
  });

  return filtered;
}

function renderOptionCard(option) {
  const fragment = els.template.content.cloneNode(true);
  const card = fragment.querySelector(".option-card");

  const score = getAverageScore(option);
  const personalScores = getPersonalScores(option);
  const totalCost = getMonthlyCost(option);

  card.querySelector(".pill--status").textContent = STATUS_LABELS[option.status] || "Sin estado";
  card.querySelector(".pill--score").textContent = score === null ? "Sin calificar" : `${Math.round(score)}/100`;
  card.querySelector(".option-title").textContent = option.title || "Sin nombre";
  card.querySelector(".option-location").textContent = [option.zone, option.address].filter(Boolean).join(" · ") || "Sin ubicación";
  card.querySelector(".total-cost").textContent = totalCost ? formatCOP(totalCost) : "—";
  card.querySelector(".area-value").textContent = option.area ? `${formatNumber(option.area)} m²` : "—";
  card.querySelector(".rooms-value").textContent = option.rooms ? formatCount(option.rooms, "salón", "salones") : "—";
  card.querySelector(".bathrooms-value").textContent = option.bathrooms ? formatCount(option.bathrooms, "baño", "baños") : "—";

  const favoriteBtn = card.querySelector(".favorite-btn");
  favoriteBtn.textContent = option.favorite || option.status === "favorita" ? "♥" : "♡";
  favoriteBtn.classList.toggle("is-favorite", Boolean(option.favorite || option.status === "favorita"));
  favoriteBtn.addEventListener("click", () => toggleFavorite(option));

  const ratingsSummary = card.querySelector(".ratings-summary");
  ratingsSummary.innerHTML = "";

  ["alek", "cata"].forEach((key) => {
    const profile = TEAM[key];
    const value = personalScores[key];

    const line = document.createElement("div");
    line.className = "rating-line";
    line.innerHTML = `
      <span>${profile.label}</span>
      <div class="rating-bar"><span style="width: ${value ?? 0}%"></span></div>
      <strong>${value === null ? "—" : Math.round(value)}</strong>
    `;

    ratingsSummary.appendChild(line);
  });

  const tags = [...(option.tags || [])];
  if (option.favorite) tags.unshift("favorita");
  if (option.status === "descartada") tags.unshift("descartada");

  const tagsList = card.querySelector(".tags-list");
  tagsList.innerHTML = tags.length
    ? tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")
    : `<span class="tag">sin etiquetas</span>`;

  card.querySelector(".pros-text").textContent = option.pros || "Sin pros registrados.";
  card.querySelector(".cons-text").textContent = option.cons || "Sin contras registrados.";
  card.querySelector(".risks-text").textContent = listToText(option.risks, "Sin riesgos registrados.");
  card.querySelector(".next-action-text").textContent = formatNextAction(option);
  card.querySelector(".notes-text").textContent = option.notes || "Sin notas.";

  const mapsLink = card.querySelector(".maps-link");
  mapsLink.href = getMapsUrl(option);
  mapsLink.classList.toggle("hidden", !option.address && !option.zone);

  const listingLink = card.querySelector(".listing-link");
  listingLink.href = option.listingUrl || "#";
  listingLink.classList.toggle("hidden", !option.listingUrl);

  card.querySelector(".rate-btn").addEventListener("click", () => openRatingDialog(option));
  card.querySelector(".edit-btn").addEventListener("click", () => openOptionDialog(option));
  card.querySelector(".delete-btn").addEventListener("click", () => deleteOption(option));

  return fragment;
}

function renderRatingCriteria() {
  els.ratingCriteria.innerHTML = "";

  CRITERIA.forEach((criterion) => {
    const row = document.createElement("div");
    row.className = "rating-item";
    row.innerHTML = `
      <div class="rating-item__top">
        <div>
          <strong>${criterion.label}</strong><br>
          <small>${criterion.help}</small>
        </div>
        <strong data-rating-value="${criterion.key}">3</strong>
      </div>
      <input
        type="range"
        min="1"
        max="5"
        step="1"
        value="3"
        name="${criterion.key}"
        aria-label="${criterion.label}"
      />
    `;

    const range = row.querySelector("input");
    const value = row.querySelector(`[data-rating-value="${criterion.key}"]`);

    range.addEventListener("input", () => {
      value.textContent = range.value;
    });

    els.ratingCriteria.appendChild(row);
  });
}

function openOptionDialog(option = null) {
  els.optionForm.reset();

  if (!option) {
    els.optionDialogTitle.textContent = "Agregar opción";
    optionInputs.id.value = "";
    optionInputs.status.value = "nueva";
    els.optionDialog.showModal();
    return;
  }

  els.optionDialogTitle.textContent = "Editar opción";
  optionInputs.id.value = option.id;
  optionInputs.title.value = option.title || "";
  optionInputs.status.value = option.status || "nueva";
  optionInputs.zone.value = option.zone || "";
  optionInputs.address.value = option.address || "";
  optionInputs.rent.value = option.rent || "";
  optionInputs.administration.value = option.administration || "";
  optionInputs.servicesEstimate.value = option.servicesEstimate || "";
  optionInputs.setupEstimate.value = option.setupEstimate || "";
  optionInputs.area.value = option.area || "";
  optionInputs.rooms.value = option.rooms || "";
  optionInputs.bathrooms.value = option.bathrooms || "";
  optionInputs.visitDate.value = option.visitDate || "";
  optionInputs.nextActionDate.value = option.nextActionDate || "";
  optionInputs.nextAction.value = option.nextAction || "";
  optionInputs.contactName.value = option.contactName || "";
  optionInputs.contactPhone.value = option.contactPhone || "";
  optionInputs.listingUrl.value = option.listingUrl || "";
  optionInputs.tags.value = (option.tags || []).join(", ");
  optionInputs.risks.value = (option.risks || []).join(", ");
  optionInputs.pros.value = option.pros || "";
  optionInputs.cons.value = option.cons || "";
  optionInputs.notes.value = option.notes || "";
  optionInputs.favorite.checked = Boolean(option.favorite);

  els.optionDialog.showModal();
}

async function handleOptionSubmit(event) {
  event.preventDefault();

  const payload = {
    title: clean(optionInputs.title.value),
    status: optionInputs.status.value,
    zone: clean(optionInputs.zone.value),
    address: clean(optionInputs.address.value),
    rent: safeNumber(optionInputs.rent.value),
    administration: safeNumber(optionInputs.administration.value),
    servicesEstimate: safeNumber(optionInputs.servicesEstimate.value),
    setupEstimate: safeNumber(optionInputs.setupEstimate.value),
    area: safeNumber(optionInputs.area.value),
    rooms: safeNumber(optionInputs.rooms.value),
    bathrooms: safeNumber(optionInputs.bathrooms.value),
    visitDate: optionInputs.visitDate.value || "",
    nextActionDate: optionInputs.nextActionDate.value || "",
    nextAction: clean(optionInputs.nextAction.value),
    contactName: clean(optionInputs.contactName.value),
    contactPhone: clean(optionInputs.contactPhone.value),
    listingUrl: clean(optionInputs.listingUrl.value),
    tags: splitList(optionInputs.tags.value),
    risks: splitList(optionInputs.risks.value),
    pros: clean(optionInputs.pros.value),
    cons: clean(optionInputs.cons.value),
    notes: clean(optionInputs.notes.value),
    favorite: optionInputs.favorite.checked,
    updatedAt: serverTimestamp(),
    updatedBy: state.profile.key
  };

  const id = optionInputs.id.value;

  try {
    if (id) {
      await updateDoc(doc(db, "rentalOptions", id), payload);
    } else {
      await addDoc(collection(db, "rentalOptions"), {
        ...payload,
        ratings: {},
        createdAt: serverTimestamp(),
        createdBy: state.profile.key
      });
    }

    els.optionDialog.close();
  } catch (error) {
    console.error("Error guardando opción:", error);
    alert("No se pudo guardar. Revisa permisos de Firebase.");
  }
}

function openRatingDialog(option) {
  const profile = state.profile;
  const rating = option.ratings?.[profile.key];

  document.querySelector("#ratingOptionId").value = option.id;
  els.ratingDialogTitle.textContent = option.title || "Calificar opción";
  els.ratingUserLabel.textContent = `Calificando como ${profile.label}`;

  CRITERIA.forEach((criterion) => {
    const input = els.ratingCriteria.querySelector(`[name="${criterion.key}"]`);
    const value = els.ratingCriteria.querySelector(`[data-rating-value="${criterion.key}"]`);
    const savedValue = rating?.scores?.[criterion.key] ?? 3;

    input.value = savedValue;
    value.textContent = savedValue;
  });

  document.querySelector("#ratingNotesInput").value = rating?.notes || "";

  els.ratingDialog.showModal();
}

async function handleRatingSubmit(event) {
  event.preventDefault();

  const optionId = document.querySelector("#ratingOptionId").value;
  const scores = {};

  CRITERIA.forEach((criterion) => {
    const input = els.ratingCriteria.querySelector(`[name="${criterion.key}"]`);
    scores[criterion.key] = safeNumber(input.value);
  });

  const rating = {
    scores,
    notes: clean(document.querySelector("#ratingNotesInput").value),
    score: calculateScoreFromScores(scores),
    updatedAt: new Date().toISOString(),
    updatedBy: state.profile.email
  };

  try {
    await updateDoc(doc(db, "rentalOptions", optionId), {
      [`ratings.${state.profile.key}`]: rating,
      updatedAt: serverTimestamp(),
      updatedBy: state.profile.key
    });

    els.ratingDialog.close();
  } catch (error) {
    console.error("Error guardando calificación:", error);
    alert("No se pudo guardar la calificación. Revisa permisos de Firebase.");
  }
}

async function toggleFavorite(option) {
  try {
    await updateDoc(doc(db, "rentalOptions", option.id), {
      favorite: !option.favorite,
      status: !option.favorite ? "favorita" : option.status === "favorita" ? "visitada" : option.status,
      updatedAt: serverTimestamp(),
      updatedBy: state.profile.key
    });
  } catch (error) {
    console.error("Error marcando favorita:", error);
    alert("No se pudo actualizar favorita.");
  }
}

async function deleteOption(option) {
  const ok = confirm(`¿Eliminar "${option.title}"? Esto no se puede deshacer.`);
  if (!ok) return;

  try {
    await deleteDoc(doc(db, "rentalOptions", option.id));
  } catch (error) {
    console.error("Error eliminando opción:", error);
    alert("No se pudo eliminar. Revisa permisos.");
  }
}

// ---- Modo Agente: claves para IA ----

function openAgentDialog() {
  els.newTokenBox.classList.add("hidden");
  els.newTokenBox.innerHTML = "";
  els.agentPromptOutput.value = "";
  els.agentTokenLabel.value = "";
  els.agentDialog.showModal();
  loadTokens();
}

async function handleGenerateToken() {
  if (!state.profile) return;

  els.generateTokenBtn.disabled = true;
  els.generateTokenBtn.textContent = "Generando…";

  try {
    const key = generateRandomKey();
    const tokenHash = await sha256hex(key);
    const expiresAt = Timestamp.fromMillis(Date.now() + AGENT_CONFIG.tokenDays * 24 * 60 * 60 * 1000);

    await addDoc(collection(db, "agentTokens"), {
      tokenHash,
      tokenPreview: `${key.slice(0, 4)}…${key.slice(-4)}`,
      label: clean(els.agentTokenLabel.value) || "Sin nombre",
      createdBy: state.profile.email,
      createdAt: serverTimestamp(),
      expiresAt,
      revoked: false,
      lastUsedAt: null,
      useCount: 0
    });

    const prompt = buildAgentPrompt(key);
    els.agentPromptOutput.value = prompt;

    els.newTokenBox.classList.remove("hidden");
    els.newTokenBox.innerHTML = `
      <strong>Clave creada (cópiala ahora, no se vuelve a mostrar):</strong>
      <code class="token-code">${escapeHtml(key)}</code>
      <small>Válida hasta ${expiresAt.toDate().toLocaleDateString("es-CO")}. El prompt de abajo ya la incluye.</small>
    `;

    await copyAgentPrompt();
    loadTokens();
  } catch (error) {
    console.error("Error generando clave:", error);
    alert("No se pudo generar la clave. Revisa permisos de Firebase.");
  } finally {
    els.generateTokenBtn.disabled = false;
    els.generateTokenBtn.textContent = "Generar clave para IA";
  }
}

function buildAgentPrompt(key) {
  return AGENT_PROMPT_TEMPLATE
    .replaceAll("{{ENDPOINT}}", AGENT_CONFIG.functionUrl)
    .replaceAll("{{IMPORT_URL}}", AGENT_CONFIG.importPageUrl)
    .replaceAll("{{KEY}}", key)
    .replaceAll("{{DAYS}}", String(AGENT_CONFIG.tokenDays));
}

async function copyAgentPrompt() {
  const text = els.agentPromptOutput.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    els.copyPromptBtn.textContent = "¡Copiado!";
    setTimeout(() => {
      els.copyPromptBtn.textContent = "Copiar prompt";
    }, 1500);
  } catch (error) {
    els.agentPromptOutput.select();
  }
}

async function loadTokens() {
  els.tokenList.textContent = "Cargando…";
  try {
    const snapshot = await getDocs(query(collection(db, "agentTokens"), orderBy("createdAt", "desc")));
    if (snapshot.empty) {
      els.tokenList.textContent = "Aún no hay claves generadas.";
      return;
    }

    els.tokenList.innerHTML = "";
    snapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const expired = data.expiresAt?.toMillis ? data.expiresAt.toMillis() < Date.now() : false;
      const stateLabel = data.revoked ? "Revocada" : expired ? "Vencida" : "Activa";

      const row = document.createElement("div");
      row.className = "token-row";
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(data.label || "Sin nombre")}</strong>
          <small>${escapeHtml(data.tokenPreview || "")} · ${stateLabel} · usos: ${data.useCount || 0}</small>
        </div>
      `;

      if (!data.revoked && !expired) {
        const btn = document.createElement("button");
        btn.className = "btn btn--tiny btn--danger";
        btn.textContent = "Revocar";
        btn.addEventListener("click", () => revokeToken(docSnap.id, data.label));
        row.appendChild(btn);
      }

      els.tokenList.appendChild(row);
    });
  } catch (error) {
    console.error("Error cargando claves:", error);
    els.tokenList.textContent = "No se pudieron cargar las claves.";
  }
}

async function revokeToken(id, label) {
  if (!confirm(`¿Revocar la clave "${label || ""}"? La IA dejará de poder importar con ella.`)) return;
  try {
    await updateDoc(doc(db, "agentTokens", id), { revoked: true });
    loadTokens();
  } catch (error) {
    console.error("Error revocando clave:", error);
    alert("No se pudo revocar la clave.");
  }
}

function generateRandomKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256hex(value) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function calculateScoreFromScores(scores) {
  const totalWeight = CRITERIA.reduce((sum, item) => sum + item.weight, 0);
  const weighted = CRITERIA.reduce((sum, item) => {
    const value = clamp(safeNumber(scores[item.key]) || 0, 1, 5);
    return sum + value * item.weight;
  }, 0);

  return Math.round((weighted / (5 * totalWeight)) * 100);
}

function getPersonalScores(option) {
  return {
    alek: option.ratings?.alek?.score ?? null,
    cata: option.ratings?.cata?.score ?? null
  };
}

function getAverageScore(option) {
  const scores = Object.values(getPersonalScores(option)).filter((value) => value !== null && !Number.isNaN(value));
  if (!scores.length) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function getMonthlyCost(option) {
  return safeNumber(option.rent) + safeNumber(option.administration) + safeNumber(option.servicesEstimate);
}

function formatNextAction(option) {
  const action = option.nextAction || "Sin próxima acción.";
  const date = option.nextActionDate ? ` (${option.nextActionDate})` : "";
  return `${action}${date}`;
}

function getMapsUrl(option) {
  const query = encodeURIComponent([option.address, option.zone, "Bogotá, Colombia"].filter(Boolean).join(", "));
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function listToText(list, fallback) {
  if (!Array.isArray(list) || !list.length) return fallback;
  return list.join(", ");
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clean(value) {
  return String(value || "").trim();
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatCOP(value) {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(value || 0);
}

function formatCount(value, singular, plural) {
  const number = safeNumber(value);
  if (!number) return "—";
  const formatted = formatNumber(number);
  return `${formatted} ${number === 1 ? singular : plural}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 1
  }).format(value || 0);
}

function getMillis(timestamp) {
  if (!timestamp) return 0;
  if (typeof timestamp.toMillis === "function") return timestamp.toMillis();
  if (typeof timestamp === "string") return new Date(timestamp).getTime();
  return 0;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
