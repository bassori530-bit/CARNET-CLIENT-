import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Plus,
  ImagePlus,
  Sparkles,
  Loader2,
  Save,
  Trash2,
  X,
  PackageSearch,
  Clock3,
  Search,
  Camera,
  ChevronDown,
  CheckCircle2,
  CircleDot,
  Pencil,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Carnet Client — registre de clients (chaussures) conçu pour tenir un très
// grand nombre de fiches. L'index (nom / numéro / lieu / pointure / statut)
// est stocké séparément des photos, réparti en blocs de plusieurs milliers
// de fiches chacun, afin de ne jamais buter sur la limite de taille d'une
// seule clé de stockage. Les photos ne sont chargées qu'à l'ouverture d'une
// fiche, jamais pour la liste entière : la liste reste rapide même avec
// énormément de clients.
// ---------------------------------------------------------------------------

const MAX_PER_CHUNK = 12000; // fiches (texte seul) par bloc d'index
const PAGE_SIZE = 30;

const EMPTY_DRAFT = () => ({
  nom: "",
  numero: "",
  lieu: "",
  pointure: "",
  detailsArticle: "",
  statut: "en_cours",
  screenshot: null,
  articlePhotos: [],
  dateHeure: toLocalInputValue(new Date()),
});

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatStamp(isoLike) {
  const d = new Date(isoLike);
  if (isNaN(d.getTime())) return { day: "--", month: "---", time: "--:--" };
  const day = String(d.getDate()).padStart(2, "0");
  const month = d
    .toLocaleDateString("fr-FR", { month: "short" })
    .replace(".", "")
    .toUpperCase();
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
  return { day, month, time };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [, data] = reader.result.split(",");
      resolve({ data, mediaType: file.type || "image/jpeg" });
    };
    reader.onerror = () => reject(new Error("Lecture du fichier impossible"));
    reader.readAsDataURL(file);
  });
}

function safeParse(json, fallback) {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

function UploadTile({ label, hint, icon: Icon, image, onPick, onClear, accent }) {
  return (
    <div className="uptile">
      <label className="uptile-surface" style={{ borderColor: image ? accent : undefined }}>
        {image ? (
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt={label}
            className="uptile-img"
          />
        ) : (
          <span className="uptile-empty">
            <Icon size={20} strokeWidth={1.6} />
            <span className="uptile-empty-text">{hint}</span>
          </span>
        )}
        <input
          type="file"
          accept="image/*"
          className="uptile-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              onPick(await fileToBase64(file));
            } catch (err) {
              console.error(err);
            }
            e.target.value = "";
          }}
        />
      </label>
      {image && (
        <button
          type="button"
          className="uptile-clear"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClear();
          }}
          aria-label={`Retirer ${label}`}
        >
          <X size={13} strokeWidth={2.4} />
        </button>
      )}
      <div className="uptile-label">{label}</div>
    </div>
  );
}

function PhotosField({ label, hint, icon: Icon, images, onAdd, onRemove, accent }) {
  return (
    <div className="photos-field">
      <div className="photos-field-label">{label}</div>
      <div className="photos-grid">
        {images.map((img, idx) => (
          <div className="photo-thumb" key={idx}>
            <img
              src={`data:${img.mediaType};base64,${img.data}`}
              alt={`${label} ${idx + 1}`}
            />
            <button
              type="button"
              className="photo-thumb-clear"
              onClick={() => onRemove(idx)}
              aria-label="Retirer la photo"
            >
              <X size={12} strokeWidth={2.4} />
            </button>
          </div>
        ))}
        <label className="photo-add-tile" style={{ borderColor: accent }}>
          <Icon size={18} strokeWidth={1.6} />
          <span>{hint}</span>
          <input
            type="file"
            accept="image/*"
            multiple
            className="uptile-input"
            onChange={async (e) => {
              const files = Array.from(e.target.files || []);
              if (!files.length) return;
              try {
                const imgs = await Promise.all(files.map(fileToBase64));
                onAdd(imgs);
              } catch (err) {
                console.error(err);
              }
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

export default function CarnetClient() {
  const [entries, setEntries] = useState([]); // index léger (sans photos)
  const [loadingEntries, setLoadingEntries] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("tous"); // tous | en_cours | termine
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [confirmingId, setConfirmingId] = useState(null);
  const [detail, setDetail] = useState(null); // {loading, record, id}

  const chunkMapRef = useRef({}); // id -> chunk index
  const metaRef = useRef({ chunkCount: 0 });
  const confirmTimerRef = useRef(null);

  // -- Chargement initial de l'index (par blocs) ---------------------------
  useEffect(() => {
    (async () => {
      try {
        let meta = { chunkCount: 0 };
        try {
          const metaRes = await window.storage.get("client-idx-meta", false);
          if (metaRes && metaRes.value) meta = safeParse(metaRes.value, meta);
        } catch {
          // pas encore de méta = carnet vide
        }
        metaRef.current = meta;

        const chunkFetches = [];
        for (let i = 0; i < meta.chunkCount; i++) {
          chunkFetches.push(
            window.storage
              .get(`client-idx:${i}`, false)
              .then((r) => ({ i, arr: r ? safeParse(r.value, []) : [] }))
              .catch(() => ({ i, arr: [] }))
          );
        }
        const chunks = await Promise.all(chunkFetches);
        let all = [];
        chunks.forEach(({ i, arr }) => {
          arr.forEach((rec) => {
            chunkMapRef.current[rec.id] = i;
          });
          all = all.concat(arr);
        });
        all.sort((a, b) => new Date(b.dateHeure) - new Date(a.dateHeure));
        setEntries(all);
      } catch (err) {
        console.error(err);
        setLoadError("Le carnet n'a pas pu être chargé.");
      } finally {
        setLoadingEntries(false);
      }
    })();
  }, []);

  // -- Helpers de stockage par blocs ---------------------------------------
  const persistNewIndexRecord = async (record) => {
    const meta = metaRef.current;
    let chunkIdx = meta.chunkCount > 0 ? meta.chunkCount - 1 : 0;
    let arr = [];
    if (meta.chunkCount > 0) {
      const res = await window.storage
        .get(`client-idx:${chunkIdx}`, false)
        .catch(() => null);
      arr = res ? safeParse(res.value, []) : [];
    }
    if (meta.chunkCount === 0 || arr.length >= MAX_PER_CHUNK) {
      chunkIdx = meta.chunkCount;
      arr = [];
      meta.chunkCount = chunkIdx + 1;
      await window.storage.set("client-idx-meta", JSON.stringify(meta), false);
    }
    arr.push(record);
    await window.storage.set(`client-idx:${chunkIdx}`, JSON.stringify(arr), false);
    chunkMapRef.current[record.id] = chunkIdx;
  };

  const mutateChunkOf = async (id, mutator) => {
    const chunkIdx = chunkMapRef.current[id];
    if (chunkIdx === undefined) return;
    const key = `client-idx:${chunkIdx}`;
    const res = await window.storage.get(key, false).catch(() => null);
    let arr = res ? safeParse(res.value, []) : [];
    arr = mutator(arr);
    await window.storage.set(key, JSON.stringify(arr), false);
  };

  // -- Nouveau client / édition -----------------------------------------------
  const openNew = () => {
    setAnalyzeError("");
    setEditingId(null);
    setDraft(EMPTY_DRAFT());
  };
  const openEdit = (record) => {
    setAnalyzeError("");
    setEditingId(record.id);
    setDraft({
      nom: record.nom || "",
      numero: record.numero || "",
      lieu: record.lieu || "",
      pointure: record.pointure || "",
      detailsArticle: record.detailsArticle || "",
      statut: record.statut || "en_cours",
      screenshot: record.screenshot || null,
      articlePhotos: record.articlePhotos || (record.articlePhoto ? [record.articlePhoto] : []),
      dateHeure: record.dateHeure ? toLocalInputValue(new Date(record.dateHeure)) : toLocalInputValue(new Date()),
    });
    setDetail(null);
  };
  const closeForm = () => {
    setDraft(null);
    setEditingId(null);
    setAnalyzeError("");
  };

  const analyzeScreenshot = useCallback(async (img) => {
    setAnalyzing(true);
    setAnalyzeError("");
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system:
            "Tu extrais des informations depuis une capture d'écran d'une commande ou d'une étiquette d'expédition de chaussures. " +
            "Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown, au format exact : " +
            '{"nom": "...", "numero": "...", "lieu": "...", "pointure": "..."}. ' +
            "nom = nom du client/destinataire si visible (chaîne, vide si absent). " +
            "numero = numéro de commande, de suivi ou de colis visible sur l'image (chaîne, vide si absent). " +
            "lieu = lieu ou adresse de livraison / expédition (ville, pays ou adresse courte, vide si absent). " +
            "pointure = pointure de la chaussure si elle est visible (ex: '42', vide si absente). " +
            "Si une information est introuvable, mets une chaîne vide pour ce champ.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: img.mediaType, data: img.data },
                },
                {
                  type: "text",
                  text: "Extrais le nom du client, le numéro, le lieu de livraison/expédition et la pointure depuis cette capture.",
                },
              ],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`Erreur API (${response.status})`);
      const data = await response.json();
      const text = (data.content || [])
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      setDraft((prev) =>
        prev
          ? {
              ...prev,
              nom: parsed.nom || prev.nom,
              numero: parsed.numero || prev.numero,
              lieu: parsed.lieu || prev.lieu,
              pointure: parsed.pointure || prev.pointure,
            }
          : prev
      );
    } catch (err) {
      console.error(err);
      setAnalyzeError("Analyse impossible. Renseigne les champs manuellement ci-dessous.");
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const handleScreenshotPick = (img) => {
    setDraft((prev) => ({ ...prev, screenshot: img }));
    analyzeScreenshot(img);
  };

  const canSave =
    !!draft &&
    (draft.nom.trim() ||
      draft.numero.trim() ||
      draft.lieu.trim() ||
      draft.pointure.trim() ||
      draft.detailsArticle.trim() ||
      draft.screenshot ||
      draft.articlePhotos.length > 0);

  const handleSave = async () => {
    if (!draft || !canSave || saving) return;
    setAnalyzeError("");
    setSaving(true);
    const id = editingId || Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const lightRecord = {
      id,
      nom: draft.nom,
      numero: draft.numero,
      lieu: draft.lieu,
      pointure: draft.pointure,
      detailsArticle: draft.detailsArticle,
      statut: draft.statut,
      dateHeure: draft.dateHeure,
      hasScreenshot: !!draft.screenshot,
      hasArticlePhoto: draft.articlePhotos.length > 0,
    };
    const fullRecord = { ...lightRecord, screenshot: draft.screenshot, articlePhotos: draft.articlePhotos };
    try {
      if (!window.storage) throw new Error("no-storage");
      await window.storage.set(`client:${id}`, JSON.stringify(fullRecord), false);
      if (editingId) {
        await mutateChunkOf(id, (arr) => arr.map((r) => (r.id === id ? lightRecord : r)));
        setEntries((prev) =>
          prev
            .map((e) => (e.id === id ? lightRecord : e))
            .sort((a, b) => new Date(b.dateHeure) - new Date(a.dateHeure))
        );
      } else {
        await persistNewIndexRecord(lightRecord);
        setEntries((prev) =>
          [lightRecord, ...prev].sort((a, b) => new Date(b.dateHeure) - new Date(a.dateHeure))
        );
      }
      setDraft(null);
      setEditingId(null);
    } catch (err) {
      console.error(err);
      setAnalyzeError(
        err && err.message === "no-storage"
          ? "Le stockage n'est pas disponible dans cet aperçu. Ouvre l'artefact dans sa propre fenêtre puis réessaie."
          : "Impossible d'enregistrer ce client. Réessaie."
      );
    } finally {
      setSaving(false);
    }
  };

  // -- Statut ----------------------------------------------------------------
  const toggleStatus = async (id, current) => {
    const next = current === "termine" ? "en_cours" : "termine";
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, statut: next } : e)));
    if (detail && detail.record && detail.record.id === id) {
      setDetail((d) => ({ ...d, record: { ...d.record, statut: next } }));
    }
    try {
      await mutateChunkOf(id, (arr) => arr.map((r) => (r.id === id ? { ...r, statut: next } : r)));
      const res = await window.storage.get(`client:${id}`, false).catch(() => null);
      if (res && res.value) {
        const full = safeParse(res.value, null);
        if (full) {
          full.statut = next;
          await window.storage.set(`client:${id}`, JSON.stringify(full), false);
        }
      }
    } catch (err) {
      console.error(err);
    }
  };

  // -- Suppression -------------------------------------------------------------
  const askDelete = (id) => {
    if (confirmingId === id) {
      clearTimeout(confirmTimerRef.current);
      doDelete(id);
      return;
    }
    setConfirmingId(id);
    clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmingId(null), 3000);
  };

  const doDelete = async (id) => {
    setConfirmingId(null);
    setEntries((prev) => prev.filter((e) => e.id !== id));
    if (detail && detail.id === id) setDetail(null);
    try {
      await mutateChunkOf(id, (arr) => arr.filter((r) => r.id !== id));
      await window.storage.delete(`client:${id}`, false);
      delete chunkMapRef.current[id];
    } catch (err) {
      console.error(err);
    }
  };

  // -- Détail (chargement des photos à la demande) ----------------------------
  const openDetail = async (light) => {
    setDetail({ id: light.id, loading: true, record: light });
    try {
      const res = await window.storage.get(`client:${light.id}`, false);
      const full = res && res.value ? safeParse(res.value, light) : light;
      setDetail({ id: light.id, loading: false, record: full });
    } catch (err) {
      console.error(err);
      setDetail({ id: light.id, loading: false, record: light });
    }
  };

  // -- Filtrage / recherche / pagination ---------------------------------------
  const filtered = useMemo(() => {
    let list = entries;
    if (tab !== "tous") list = list.filter((e) => e.statut === tab);
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (e) =>
          (e.nom || "").toLowerCase().includes(q) ||
          (e.numero || "").toLowerCase().includes(q) ||
          (e.lieu || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [entries, tab, query]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [tab, query]);

  const counts = useMemo(() => {
    const c = { tous: entries.length, en_cours: 0, termine: 0 };
    entries.forEach((e) => {
      if (e.statut === "termine") c.termine++;
      else c.en_cours++;
    });
    return c;
  }, [entries]);

  const visible = filtered.slice(0, visibleCount);

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        .app {
          --paper: #FAF7EF; --paper-raised: #FFFFFF; --ink: #1E2A44; --ink-soft: #4B5568;
          --label-red: #C1440E; --label-red-dark: #9C3609; --tape: #E7B93D;
          --line: #E1D9C6; --line-strong: #CFC3A5; --ok-green: #4C7A5E; --ok-green-bg: #E7F0EA;
          --amber-bg: #FBF0D9; --amber-fg: #97690F;
          min-height: 100vh;
          background: radial-gradient(circle at 1px 1px, rgba(30,42,68,0.055) 1px, transparent 0) 0 0/22px 22px, var(--paper);
          font-family: 'Inter', -apple-system, sans-serif; color: var(--ink); padding-bottom: 48px;
        }
        .topbar { position: sticky; top: 0; z-index: 20; background: rgba(250,247,239,0.92); backdrop-filter: blur(6px); border-bottom: 1px solid var(--line); padding: 18px 20px 14px; }
        .topbar-inner { max-width: 600px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .brand-eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.14em; color: var(--label-red); font-weight: 600; text-transform: uppercase; margin: 0 0 2px; }
        .brand-title { font-size: 21px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
        .new-btn { display: flex; align-items: center; gap: 6px; background: var(--ink); color: var(--paper); border: none; border-radius: 10px; padding: 10px 14px; font-weight: 600; font-size: 13.5px; cursor: pointer; transition: transform 0.12s ease, background 0.15s ease; flex-shrink: 0; }
        .new-btn:hover { background: #14203a; } .new-btn:active { transform: scale(0.96); }
        .content { max-width: 600px; margin: 0 auto; padding: 20px; }

        .panel { background: var(--paper-raised); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin-bottom: 28px; box-shadow: 0 1px 2px rgba(30,42,68,0.04), 0 8px 24px -12px rgba(30,42,68,0.12); animation: rise 0.22s ease; }
        @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .panel-head h2 { font-size: 15px; font-weight: 700; margin: 0; }
        .panel-close { background: none; border: none; color: var(--ink-soft); cursor: pointer; padding: 4px; border-radius: 6px; }
        .panel-close:hover { background: rgba(30,42,68,0.06); }

        .status-toggle { display: flex; gap: 8px; margin-bottom: 16px; }
        .status-pill { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px; border-radius: 9px; border: 1.5px solid var(--line-strong); background: #fff; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--ink-soft); }
        .status-pill.active-cours { border-color: var(--amber-fg); background: var(--amber-bg); color: var(--amber-fg); }
        .status-pill.active-termine { border-color: var(--ok-green); background: var(--ok-green-bg); color: var(--ok-green); }

        .uploads-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; max-width: 50%; }
        @media (max-width: 380px) { .uploads-row { max-width: 100%; } }
        .uptile-surface { width: 100%; aspect-ratio: 4/3; border: 1.5px dashed var(--line-strong); border-radius: 12px; background: #FBFAF5; display: flex; align-items: center; justify-content: center; cursor: pointer; padding: 0; overflow: hidden; position: relative; transition: border-color 0.15s ease; }
        .uptile-surface:hover { border-color: var(--label-red); }
        .uptile-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
        .uptile-img { width: 100%; height: 100%; object-fit: cover; }
        .uptile-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--ink-soft); }
        .uptile-empty-text { font-size: 11.5px; font-weight: 500; text-align: center; padding: 0 8px; }
        .uptile-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin-top: 6px; text-align: center; }
        .uptile { position: relative; }
        .uptile-clear { position: absolute; top: 6px; right: 6px; width: 22px; height: 22px; border-radius: 50%; background: rgba(30,42,68,0.75); color: #fff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }

        .photos-field { margin-bottom: 18px; }
        .photos-field-label { font-family: 'JetBrains Mono', monospace; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 8px; font-weight: 600; }
        .photos-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
        .photo-thumb { position: relative; aspect-ratio: 4/3; border-radius: 10px; overflow: hidden; border: 1px solid var(--line); }
        .photo-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .photo-thumb-clear { position: absolute; top: 5px; right: 5px; width: 20px; height: 20px; border-radius: 50%; background: rgba(30,42,68,0.75); color: #fff; border: none; display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .photo-add-tile { aspect-ratio: 4/3; border: 1.5px dashed var(--line-strong); border-radius: 10px; background: #FBFAF5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5px; cursor: pointer; color: var(--ink-soft); position: relative; overflow: hidden; text-align: center; padding: 6px; transition: border-color 0.15s ease; }
        .photo-add-tile:hover { border-color: var(--label-red); }
        .photo-add-tile span { font-size: 10.5px; font-weight: 500; line-height: 1.3; }

        .analyzing-strip { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--label-red-dark); background: #FBEEE4; border: 1px solid #F0D3B8; border-radius: 8px; padding: 8px 10px; margin-bottom: 14px; font-weight: 500; }
        .analyzing-strip.err { color: #8A3A22; background: #FBEDE7; }
        .spin { animation: spin 0.9s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }

        .field { margin-bottom: 13px; }
        .field label { display: block; font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 5px; font-weight: 600; }
        .field input { width: 100%; border: 1.5px solid var(--line-strong); border-radius: 9px; padding: 10px 11px; font-size: 14.5px; color: var(--ink); background: #fff; transition: border-color 0.15s ease; }
        .field input:focus { outline: none; border-color: var(--ink); }
        .field.mono input { font-family: 'JetBrains Mono', monospace; font-weight: 500; }
        .field textarea { width: 100%; border: 1.5px solid var(--line-strong); border-radius: 9px; padding: 10px 11px; font-size: 14.5px; color: var(--ink); background: #fff; transition: border-color 0.15s ease; font-family: 'Inter', sans-serif; resize: vertical; }
        .field textarea:focus { outline: none; border-color: var(--ink); }
        .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }

        .panel-actions { display: flex; gap: 10px; margin-top: 18px; }
        .btn-save { flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px; background: var(--label-red); color: #fff; border: none; border-radius: 10px; padding: 12px 14px; font-weight: 700; font-size: 14px; cursor: pointer; transition: background 0.15s ease, opacity 0.15s ease; }
        .btn-save:hover:not(:disabled) { background: var(--label-red-dark); }
        .btn-save:disabled { opacity: 0.45; cursor: not-allowed; }
        .btn-cancel { background: none; border: 1.5px solid var(--line-strong); color: var(--ink-soft); border-radius: 10px; padding: 12px 16px; font-weight: 600; font-size: 14px; cursor: pointer; }
        .btn-cancel:hover { background: rgba(30,42,68,0.04); }

        .toolbar { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
        .search-box { display: flex; align-items: center; gap: 8px; background: #fff; border: 1.5px solid var(--line-strong); border-radius: 10px; padding: 9px 12px; }
        .search-box input { border: none; outline: none; flex: 1; font-size: 13.5px; background: transparent; color: var(--ink); }
        .search-box svg { color: var(--ink-soft); flex-shrink: 0; }
        .tabs { display: flex; gap: 6px; }
        .tab-btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; padding: 8px 6px; border-radius: 9px; border: 1.5px solid var(--line-strong); background: #fff; font-size: 12px; font-weight: 600; color: var(--ink-soft); cursor: pointer; white-space: nowrap; }
        .tab-btn.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }
        .tab-count { opacity: 0.7; font-family: 'JetBrains Mono', monospace; }

        .empty { text-align: center; padding: 50px 20px; color: var(--ink-soft); }
        .empty svg { color: var(--line-strong); margin-bottom: 10px; }
        .empty p { font-size: 13.5px; margin: 0; line-height: 1.5; }

        .ledger-title { font-family: 'JetBrains Mono', monospace; font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; margin: 0 0 12px 2px; }
        .cards { display: flex; flex-direction: column; gap: 12px; }

        .card { position: relative; display: flex; background: var(--paper-raised); border: 1px solid var(--line); border-radius: 13px; overflow: hidden; box-shadow: 0 1px 2px rgba(30,42,68,0.03), 0 4px 14px -10px rgba(30,42,68,0.18); cursor: pointer; text-align: left; width: 100%; }
        .card-tab { width: 6px; flex-shrink: 0; }
        .card-tab.en_cours { background: var(--tape); }
        .card-tab.termine { background: var(--ok-green); }
        .card-stamp { flex-shrink: 0; width: 58px; display: flex; flex-direction: column; align-items: center; justify-content: center; border-right: 1px dashed var(--line-strong); padding: 10px 4px; font-family: 'JetBrains Mono', monospace; color: var(--ink-soft); }
        .card-stamp .day { font-size: 19px; font-weight: 700; color: var(--ink); line-height: 1; }
        .card-stamp .month { font-size: 9.5px; letter-spacing: 0.06em; margin-top: 2px; }
        .card-stamp .time { display: flex; align-items: center; gap: 3px; font-size: 9.5px; margin-top: 6px; color: var(--label-red-dark); }
        .card-body { flex: 1; min-width: 0; padding: 11px 34px 11px 12px; display: flex; flex-direction: column; gap: 4px; }
        .card-nom { font-size: 14.5px; font-weight: 700; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .card-numero { font-family: 'JetBrains Mono', monospace; font-size: 15px; font-weight: 800; color: var(--ink); overflow-wrap: anywhere; }
        .card-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; font-size: 12px; color: var(--ink-soft); align-items: center; }
        .card-meta span { display: inline-flex; align-items: baseline; gap: 4px; }
        .card-meta b { color: var(--ink); font-weight: 600; }
        .card-meta-value { font-weight: 800; font-size: 14.5px; color: var(--ink); }
        .card-details { font-size: 12px; color: var(--ink-soft); line-height: 1.4; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .badge-row { display: flex; gap: 6px; align-items: center; margin-top: 2px; }
        .status-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.03em; }
        .status-badge.en_cours { background: var(--amber-bg); color: var(--amber-fg); }
        .status-badge.termine { background: var(--ok-green-bg); color: var(--ok-green); }
        .attach-icon { color: var(--line-strong); }
        .card-del { position: absolute; top: 8px; right: 8px; background: none; border: none; color: var(--line-strong); cursor: pointer; padding: 6px; border-radius: 6px; z-index: 2; }
        .card-del:hover { color: var(--label-red); background: rgba(193,68,14,0.08); }
        .card-del.confirming { background: var(--label-red); color: #fff; font-family: 'Inter', sans-serif; font-size: 10.5px; font-weight: 700; padding: 6px 9px; display: flex; align-items: center; gap: 4px; }

        .load-more { display: block; margin: 6px auto 0; background: none; border: 1.5px solid var(--line-strong); color: var(--ink-soft); border-radius: 10px; padding: 10px 18px; font-weight: 600; font-size: 13px; cursor: pointer; }
        .load-more:hover { background: rgba(30,42,68,0.04); }

        /* ---------- Detail modal ---------- */
        .modal-backdrop { position: fixed; inset: 0; background: rgba(20,28,46,0.5); backdrop-filter: blur(2px); z-index: 40; display: flex; align-items: flex-end; justify-content: center; }
        @media (min-width: 620px) { .modal-backdrop { align-items: center; } }
        .modal { background: var(--paper-raised); width: 100%; max-width: 520px; max-height: 88vh; overflow-y: auto; border-radius: 18px 18px 0 0; padding: 22px 20px 26px; animation: slideup 0.2s ease; }
        @media (min-width: 620px) { .modal { border-radius: 18px; } }
        @keyframes slideup { from { transform: translateY(16px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        .modal-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; gap: 10px; }
        .modal-head h2 { font-size: 18px; margin: 0 0 4px; font-weight: 700; }
        .modal-sub { font-family: 'JetBrains Mono', monospace; font-size: 15px; font-weight: 800; color: var(--ink); }
        .modal-imgs { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 14px 0; }
        .modal-imgs img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 10px; border: 1px solid var(--line); }
        .modal-fields { display: flex; flex-direction: column; gap: 9px; margin: 14px 0; }
        .modal-fields .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13.5px; padding: 8px 0; border-bottom: 1px solid var(--line); }
        .modal-fields .row b { color: var(--ink-soft); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-family: 'JetBrains Mono', monospace; }
        .modal-fields .row span { text-align: right; font-weight: 500; }
        .modal-fields .row span.value-strong { font-weight: 800; font-size: 16.5px; color: var(--ink); }
        .modal-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
        .btn-edit { flex: 1 1 100%; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 11px; border-radius: 10px; border: 1.5px solid var(--line-strong); background: #fff; font-weight: 600; font-size: 13.5px; cursor: pointer; color: var(--ink); }
        .btn-edit:hover { background: rgba(30,42,68,0.04); }
        .btn-status { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 11px; border-radius: 10px; border: 1.5px solid var(--line-strong); background: #fff; font-weight: 600; font-size: 13.5px; cursor: pointer; }
        .btn-delete { display: flex; align-items: center; justify-content: center; gap: 6px; padding: 11px 16px; border-radius: 10px; border: none; background: var(--label-red); color: #fff; font-weight: 700; font-size: 13.5px; cursor: pointer; }
        .btn-delete:hover { background: var(--label-red-dark); }
        .btn-delete.confirming { background: #7a2408; }
        .modal-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 0; color: var(--ink-soft); font-size: 13.5px; }

        @media (max-width: 380px) { .field-row { grid-template-columns: 1fr; } }
      `}</style>

      <header className="topbar">
        <div className="topbar-inner">
          <div>
            <p className="brand-eyebrow">Article · Suivi</p>
            <h1 className="brand-title">Carnet Client</h1>
          </div>
          {!draft && (
            <button className="new-btn" onClick={openNew}>
              <Plus size={16} strokeWidth={2.4} />
              Créer
            </button>
          )}
        </div>
      </header>

      <div className="content">
        {draft && (
          <div className="panel">
            <div className="panel-head">
              <h2>{editingId ? "Modifier le client" : "Nouveau client"}</h2>
              <button className="panel-close" onClick={closeForm} aria-label="Fermer">
                <X size={18} />
              </button>
            </div>

            <div className="status-toggle">
              <button
                type="button"
                className={`status-pill ${draft.statut === "en_cours" ? "active-cours" : ""}`}
                onClick={() => setDraft((p) => ({ ...p, statut: "en_cours" }))}
              >
                <CircleDot size={14} /> En cours
              </button>
              <button
                type="button"
                className={`status-pill ${draft.statut === "termine" ? "active-termine" : ""}`}
                onClick={() => setDraft((p) => ({ ...p, statut: "termine" }))}
              >
                <CheckCircle2 size={14} /> Terminé
              </button>
            </div>

            <div className="uploads-row">
              <UploadTile
                label="Capture d'écran"
                hint="Importer la capture (analyse auto)"
                icon={Sparkles}
                image={draft.screenshot}
                accent="#C1440E"
                onPick={handleScreenshotPick}
                onClear={() => setDraft((p) => ({ ...p, screenshot: null }))}
              />
            </div>

            <PhotosField
              label="Photos de l'article"
              hint="Ajouter une ou plusieurs photos"
              icon={ImagePlus}
              images={draft.articlePhotos}
              accent="#4C7A5E"
              onAdd={(imgs) =>
                setDraft((p) => ({ ...p, articlePhotos: [...p.articlePhotos, ...imgs] }))
              }
              onRemove={(idx) =>
                setDraft((p) => ({
                  ...p,
                  articlePhotos: p.articlePhotos.filter((_, i) => i !== idx),
                }))
              }
            />

            {analyzing && (
              <div className="analyzing-strip">
                <Loader2 size={14} className="spin" />
                Lecture de la capture en cours…
              </div>
            )}
            {!analyzing && analyzeError && <div className="analyzing-strip err">{analyzeError}</div>}

            <div className="field">
              <label>Nom du client</label>
              <input
                type="text"
                placeholder="Ex : Sophie Martin"
                value={draft.nom}
                onChange={(e) => setDraft((p) => ({ ...p, nom: e.target.value }))}
              />
            </div>

            <div className="field mono">
              <label>Numéro</label>
              <input
                type="text"
                placeholder="Ex : CMD-48213"
                value={draft.numero}
                onChange={(e) => setDraft((p) => ({ ...p, numero: e.target.value }))}
              />
            </div>

            <div className="field">
              <label>Lieu de livraison / expédition</label>
              <input
                type="text"
                placeholder="Ex : Lyon, France"
                value={draft.lieu}
                onChange={(e) => setDraft((p) => ({ ...p, lieu: e.target.value }))}
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label>Pointure</label>
                <input
                  type="text"
                  placeholder="Ex : 42"
                  value={draft.pointure}
                  onChange={(e) => setDraft((p) => ({ ...p, pointure: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Date &amp; heure</label>
                <input
                  type="datetime-local"
                  value={draft.dateHeure}
                  onChange={(e) => setDraft((p) => ({ ...p, dateHeure: e.target.value }))}
                />
              </div>
            </div>

            <div className="field">
              <label>Détails article</label>
              <textarea
                placeholder="Ex : Modèle, couleur, référence, remarques…"
                value={draft.detailsArticle}
                onChange={(e) => setDraft((p) => ({ ...p, detailsArticle: e.target.value }))}
                rows={3}
              />
            </div>

            <div className="panel-actions">
              <button className="btn-cancel" onClick={closeForm}>
                Annuler
              </button>
              <button className="btn-save" disabled={!canSave || saving} onClick={handleSave}>
                {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} strokeWidth={2.2} />}
                Enregistrer
              </button>
            </div>
          </div>
        )}

        {!loadingEntries && !loadError && entries.length > 0 && (
          <div className="toolbar">
            <div className="search-box">
              <Search size={15} />
              <input
                placeholder="Rechercher un nom, un numéro, un lieu…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="tabs">
              <button className={`tab-btn ${tab === "tous" ? "active" : ""}`} onClick={() => setTab("tous")}>
                Tous <span className="tab-count">{counts.tous}</span>
              </button>
              <button
                className={`tab-btn ${tab === "en_cours" ? "active" : ""}`}
                onClick={() => setTab("en_cours")}
              >
                En cours <span className="tab-count">{counts.en_cours}</span>
              </button>
              <button
                className={`tab-btn ${tab === "termine" ? "active" : ""}`}
                onClick={() => setTab("termine")}
              >
                Terminé <span className="tab-count">{counts.termine}</span>
              </button>
            </div>
          </div>
        )}

        {loadError && <div className="analyzing-strip err">{loadError}</div>}

        {!loadingEntries && entries.length === 0 && !draft && !loadError && (
          <div className="empty">
            <PackageSearch size={30} strokeWidth={1.4} />
            <p>
              Aucun client enregistré pour l'instant.
              <br />
              Appuie sur « Créer » et ajoute une capture pour commencer.
            </p>
          </div>
        )}

        {!loadingEntries && entries.length > 0 && filtered.length === 0 && (
          <div className="empty">
            <Search size={26} strokeWidth={1.4} />
            <p>Aucun client ne correspond à cette recherche.</p>
          </div>
        )}

        {!loadingEntries && filtered.length > 0 && (
          <p className="ledger-title">
            {filtered.length} client{filtered.length > 1 ? "s" : ""}
            {filtered.length !== entries.length ? ` sur ${entries.length}` : ""}
          </p>
        )}

        <div className="cards">
          {visible.map((entry) => {
            const stamp = formatStamp(entry.dateHeure);
            const isConfirming = confirmingId === entry.id;
            return (
              <div key={entry.id} className="card" onClick={() => openDetail(entry)} role="button" tabIndex={0}>
                <div className={`card-tab ${entry.statut}`} />
                <div className="card-stamp">
                  <span className="day">{stamp.day}</span>
                  <span className="month">{stamp.month}</span>
                  <span className="time">
                    <Clock3 size={9} /> {stamp.time}
                  </span>
                </div>
                <div className="card-body">
                  <div className="card-nom">{entry.nom || "Sans nom"}</div>
                  {entry.numero && <div className="card-numero">{entry.numero}</div>}
                  <div className="card-meta">
                    {entry.lieu && (
                      <span>
                        <b>Lieu</b> <span className="card-meta-value">{entry.lieu}</span>
                      </span>
                    )}
                    {entry.pointure && (
                      <span>
                        <b>Pointure</b> <span className="card-meta-value">{entry.pointure}</span>
                      </span>
                    )}
                  </div>
                  {entry.detailsArticle && (
                    <div className="card-details">{entry.detailsArticle}</div>
                  )}
                  <div className="badge-row">
                    <span className={`status-badge ${entry.statut}`}>
                      {entry.statut === "termine" ? "Terminé" : "En cours"}
                    </span>
                    {entry.hasScreenshot && <Camera size={13} className="attach-icon" />}
                    {entry.hasArticlePhoto && <ImagePlus size={13} className="attach-icon" />}
                  </div>
                </div>
                <button
                  className={`card-del ${isConfirming ? "confirming" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    askDelete(entry.id);
                  }}
                  aria-label="Supprimer"
                >
                  {isConfirming ? (
                    "Confirmer ?"
                  ) : (
                    <Trash2 size={15} />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {filtered.length > visible.length && (
          <button className="load-more" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
            <ChevronDown size={14} style={{ verticalAlign: "-2px", marginRight: 5 }} />
            Charger {Math.min(PAGE_SIZE, filtered.length - visible.length)} de plus
          </button>
        )}
      </div>

      {detail && (
        <div className="modal-backdrop" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {detail.loading ? (
              <div className="modal-loading">
                <Loader2 size={16} className="spin" /> Chargement de la fiche…
              </div>
            ) : (
              <>
                <div className="modal-head">
                  <div>
                    <h2>{detail.record.nom || "Sans nom"}</h2>
                    <div className="modal-sub">{detail.record.numero || "Sans numéro"}</div>
                  </div>
                  <button className="panel-close" onClick={() => setDetail(null)} aria-label="Fermer">
                    <X size={18} />
                  </button>
                </div>

                {(() => {
                  const photos =
                    detail.record.articlePhotos ||
                    (detail.record.articlePhoto ? [detail.record.articlePhoto] : []);
                  return (
                    (detail.record.screenshot || photos.length > 0) && (
                      <div className="modal-imgs">
                        {detail.record.screenshot && (
                          <img
                            src={`data:${detail.record.screenshot.mediaType};base64,${detail.record.screenshot.data}`}
                            alt="Capture"
                          />
                        )}
                        {photos.map((img, idx) => (
                          <img
                            key={idx}
                            src={`data:${img.mediaType};base64,${img.data}`}
                            alt={`Article ${idx + 1}`}
                          />
                        ))}
                      </div>
                    )
                  );
                })()}

                <div className="modal-fields">
                  <div className="row">
                    <b>Lieu</b>
                    <span className="value-strong">{detail.record.lieu || "—"}</span>
                  </div>
                  <div className="row">
                    <b>Pointure</b>
                    <span className="value-strong">{detail.record.pointure || "—"}</span>
                  </div>
                  {detail.record.detailsArticle && (
                    <div className="row">
                      <b>Détails article</b>
                      <span>{detail.record.detailsArticle}</span>
                    </div>
                  )}
                  <div className="row">
                    <b>Enregistré le</b>
                    <span>
                      {formatStamp(detail.record.dateHeure).day}{" "}
                      {formatStamp(detail.record.dateHeure).month} à{" "}
                      {formatStamp(detail.record.dateHeure).time}
                    </span>
                  </div>
                </div>

                <div className="modal-actions">
                  <button className="btn-edit" onClick={() => openEdit(detail.record)}>
                    <Pencil size={15} /> Modifier
                  </button>
                  <button
                    className="btn-status"
                    onClick={() => toggleStatus(detail.record.id, detail.record.statut)}
                  >
                    {detail.record.statut === "termine" ? (
                      <>
                        <CircleDot size={15} /> Repasser en cours
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={15} /> Marquer terminé
                      </>
                    )}
                  </button>
                  <button
                    className={`btn-delete ${confirmingId === detail.record.id ? "confirming" : ""}`}
                    onClick={() => askDelete(detail.record.id)}
                  >
                    <Trash2 size={15} />
                    {confirmingId === detail.record.id ? "Confirmer" : "Supprimer"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Montage de l'application dans la page (remplace l'hôte Claude Artifacts)
// ---------------------------------------------------------------------------
import { createRoot } from "react-dom/client";

const rootEl = document.getElementById("root");
createRoot(rootEl).render(<CarnetClient />);
