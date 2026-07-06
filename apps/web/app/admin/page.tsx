"use client";

import { useCallback, useEffect, useState } from "react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const PW_STORAGE_KEY = "onrecord.admin.password";

interface DeadLetterItem {
  id: string;
  headline?: string;
  type?: string;
  reason?: string;
}

type LogRow = Record<string, unknown>;

/** Some endpoints may wrap lists as { items: [...] } — accept either. */
function toArray<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (
    data !== null &&
    typeof data === "object" &&
    Array.isArray((data as { items?: unknown }).items)
  ) {
    return (data as { items: T[] }).items;
  }
  return [];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [deadLetter, setDeadLetter] = useState<DeadLetterItem[]>([]);
  const [configText, setConfigText] = useState("");
  const [logRows, setLogRows] = useState<LogRow[]>([]);

  // One status line per section.
  const [msgs, setMsgs] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, boolean>>({});

  const [storyId, setStoryId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [bucketId, setBucketId] = useState("");
  const [bucketName, setBucketName] = useState("");
  const [announceUrl, setAnnounceUrl] = useState("");
  const [announceProgram, setAnnounceProgram] = useState("");
  const [watchProgram, setWatchProgram] = useState("");
  const [watchAuthority, setWatchAuthority] = useState("");
  const [watchNote, setWatchNote] = useState("");

  const say = useCallback((section: string, text: string, isError = false) => {
    setMsgs((prev) => ({ ...prev, [section]: text }));
    setErrs((prev) => ({ ...prev, [section]: isError }));
  }, []);

  const call = useCallback(
    async (path: string, pw: string, init?: RequestInit): Promise<Response | null> => {
      try {
        const res = await fetch(`${API_BASE}${path}`, {
          ...init,
          headers: {
            ...(init?.headers ?? {}),
            Authorization: `Basic ${btoa(`admin:${pw}`)}`,
          },
        });
        if (res.status === 401) {
          setAuthed(false);
          setAuthError("Wrong password");
          try {
            sessionStorage.removeItem(PW_STORAGE_KEY);
          } catch {
            // sessionStorage unavailable — nothing to clear
          }
          return null;
        }
        return res;
      } catch {
        return null;
      }
    },
    []
  );

  const loadDeadLetter = useCallback(
    async (pw: string) => {
      const res = await call("/admin/dead-letter", pw);
      if (res?.ok) setDeadLetter(toArray<DeadLetterItem>(await res.json()));
    },
    [call]
  );

  const loadConfig = useCallback(
    async (pw: string) => {
      const res = await call("/admin/config", pw);
      if (res?.ok) {
        try {
          setConfigText(JSON.stringify(await res.json(), null, 2));
        } catch {
          say("config", "Could not read config from the API", true);
        }
      }
    },
    [call, say]
  );

  const loadLog = useCallback(
    async (pw: string) => {
      const res = await call("/admin/log", pw);
      if (res?.ok) setLogRows(toArray<LogRow>(await res.json()));
    },
    [call]
  );

  const unlock = useCallback(
    async (pw: string) => {
      if (!pw) return;
      setAuthError(null);
      const res = await call("/admin/dead-letter", pw);
      if (res === null) {
        // Either a 401 (authError already set) or the API is unreachable.
        setAuthError((prev) => prev ?? "Could not reach the API");
        return;
      }
      if (!res.ok) {
        setAuthError(`API answered ${res.status} — try again`);
        return;
      }
      try {
        sessionStorage.setItem(PW_STORAGE_KEY, pw);
      } catch {
        // Private-mode browsers may block storage; the session still works.
      }
      setAuthed(true);
      setDeadLetter(toArray<DeadLetterItem>(await res.json()));
      void loadConfig(pw);
      void loadLog(pw);
    },
    [call, loadConfig, loadLog]
  );

  // Resume a session if the password is already stored.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(PW_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored) {
      setPassword(stored);
      void unlock(stored);
    }
  }, [unlock]);

  // ---- actions ----

  const retryDeadLetter = async (id: string) => {
    const res = await call(`/admin/dead-letter/${encodeURIComponent(id)}/retry`, password, {
      method: "POST",
    });
    if (res?.ok) {
      say("dead", `Retried ${id}`);
      void loadDeadLetter(password);
      void loadLog(password);
    } else if (res) {
      say("dead", `Retry failed (${res.status})`, true);
    } else if (authed) {
      say("dead", "Could not reach the API", true);
    }
  };

  const storyAction = async (
    id: string,
    action: "kill" | "pin" | "unpin" | "restore",
    section = "stories"
  ) => {
    const trimmed = id.trim();
    if (!trimmed) {
      say(section, "Enter a story id first", true);
      return;
    }
    const res = await call(
      `/admin/stories/${encodeURIComponent(trimmed)}/${action}`,
      password,
      { method: "POST" }
    );
    if (res?.ok) {
      say(section, `${action === "kill" ? "Killed" : action === "pin" ? "Pinned" : action === "unpin" ? "Unpinned" : "Restored"} ${trimmed}`);
      void loadDeadLetter(password);
      void loadLog(password);
    } else if (res) {
      say(section, `${action} failed (${res.status})`, true);
    } else if (authed) {
      say(section, "Could not reach the API", true);
    }
  };

  const postJson = async (
    section: string,
    path: string,
    body: Record<string, unknown>,
    okText: string,
    method: "POST" | "PUT" = "POST"
  ) => {
    const res = await call(path, password, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res?.ok) {
      say(section, okText);
      void loadLog(password);
      return true;
    }
    if (res) {
      say(section, `Failed (${res.status})`, true);
    } else if (authed) {
      say(section, "Could not reach the API", true);
    }
    return false;
  };

  const saveConfig = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configText);
    } catch {
      say("config", "That isn't valid JSON — fix it and save again", true);
      return;
    }
    const res = await call("/admin/config", password, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed),
    });
    if (res?.ok) {
      say("config", "Config saved");
      void loadLog(password);
    } else if (res) {
      say("config", `Save failed (${res.status})`, true);
    } else if (authed) {
      say("config", "Could not reach the API", true);
    }
  };

  const message = (section: string) =>
    msgs[section] ? (
      <p className={`admin-msg${errs[section] ? " admin-msg-error" : ""}`} role="status">
        {msgs[section]}
      </p>
    ) : null;

  // ---- locked ----

  if (!authed) {
    return (
      <div className="lock-card">
        <h1>OPERATOR DESK</h1>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock(password);
          }}
        >
          <input
            className="field field-wide"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Operator password"
            autoComplete="current-password"
          />
          <button className="btn" type="submit">
            Unlock
          </button>
        </form>
        {authError ? (
          <p className="admin-msg admin-msg-error" role="alert">
            {authError}
          </p>
        ) : null}
      </div>
    );
  }

  // ---- unlocked ----

  const logColumns =
    logRows.length > 0 ? Object.keys(logRows[0] ?? {}).slice(0, 6) : [];

  return (
    <div className="admin-wrap">
      <h1 className="section-header" style={{ marginBottom: 0 }}>
        Operator desk
      </h1>

      <section className="admin-section" aria-labelledby="dead-letter-h">
        <h2 id="dead-letter-h">Dead letter review</h2>
        <p className="admin-hint">
          Stories the pipeline gave up on. Retry to run them again, restore to
          publish as-is, kill to drop them for good.
        </p>
        {deadLetter.length === 0 ? (
          <p className="admin-msg">Nothing in the dead-letter queue.</p>
        ) : (
          <ul className="admin-list">
            {deadLetter.map((item) => (
              <li key={item.id}>
                <span className="grow">
                  <span className="item-head">
                    {item.headline ?? "(no headline)"}
                  </span>
                  <br />
                  <span className="item-sub">
                    {item.id}
                    {item.reason ? ` — ${item.reason}` : ""}
                  </span>
                </span>
                <button
                  className="btn btn-small"
                  onClick={() => void retryDeadLetter(item.id)}
                >
                  Retry
                </button>
                <button
                  className="btn btn-small"
                  onClick={() => void storyAction(item.id, "restore", "dead")}
                >
                  Restore
                </button>
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => void storyAction(item.id, "kill", "dead")}
                >
                  Kill
                </button>
              </li>
            ))}
          </ul>
        )}
        {message("dead")}
      </section>

      <section className="admin-section" aria-labelledby="stories-h">
        <h2 id="stories-h">Story controls</h2>
        <p className="admin-hint">Act on any story by id.</p>
        <div className="admin-form">
          <input
            className="field field-wide"
            value={storyId}
            onChange={(e) => setStoryId(e.target.value)}
            placeholder="Story id"
            aria-label="Story id"
          />
          <button className="btn" onClick={() => void storyAction(storyId, "pin")}>
            Pin
          </button>
          <button className="btn" onClick={() => void storyAction(storyId, "unpin")}>
            Unpin
          </button>
          <button className="btn" onClick={() => void storyAction(storyId, "restore")}>
            Restore
          </button>
          <button
            className="btn btn-danger"
            onClick={() => void storyAction(storyId, "kill")}
          >
            Kill
          </button>
        </div>
        {message("stories")}
      </section>

      <section className="admin-section" aria-labelledby="name-h">
        <h2 id="name-h">Name a subject</h2>
        <p className="admin-hint">
          Give an app or a copy-wave bucket a human name for the feed.
        </p>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void postJson(
              "name",
              "/admin/name",
              { subjectId: subjectId.trim(), name: subjectName.trim() },
              `Named ${subjectId.trim()} “${subjectName.trim()}”`
            ).then((ok) => {
              if (ok) {
                setSubjectId("");
                setSubjectName("");
              }
            });
          }}
        >
          <input
            className="field field-wide"
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            placeholder="Subject id"
            aria-label="Subject id"
            required
          />
          <input
            className="field field-wide"
            value={subjectName}
            onChange={(e) => setSubjectName(e.target.value)}
            placeholder="Name"
            aria-label="Subject name"
            required
          />
          <button className="btn" type="submit">
            Name subject
          </button>
        </form>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void postJson(
              "name",
              "/admin/name",
              { bucketId: bucketId.trim(), name: bucketName.trim() },
              `Named bucket ${bucketId.trim()} “${bucketName.trim()}”`
            ).then((ok) => {
              if (ok) {
                setBucketId("");
                setBucketName("");
              }
            });
          }}
        >
          <input
            className="field field-wide"
            value={bucketId}
            onChange={(e) => setBucketId(e.target.value)}
            placeholder="Bucket id"
            aria-label="Bucket id"
            required
          />
          <input
            className="field field-wide"
            value={bucketName}
            onChange={(e) => setBucketName(e.target.value)}
            placeholder="Name"
            aria-label="Bucket name"
            required
          />
          <button className="btn" type="submit">
            Name bucket
          </button>
        </form>
        {message("name")}
      </section>

      <section className="admin-section" aria-labelledby="announce-h">
        <h2 id="announce-h">Feed an announcement</h2>
        <p className="admin-hint">
          Point the newsroom at a public claim so it can check the claim
          against what actually ships.
        </p>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void postJson(
              "announce",
              "/admin/announcement",
              { url: announceUrl.trim(), programId: announceProgram.trim() },
              "Announcement queued"
            ).then((ok) => {
              if (ok) {
                setAnnounceUrl("");
                setAnnounceProgram("");
              }
            });
          }}
        >
          <input
            className="field field-wide"
            type="url"
            value={announceUrl}
            onChange={(e) => setAnnounceUrl(e.target.value)}
            placeholder="Announcement URL"
            aria-label="Announcement URL"
            required
          />
          <input
            className="field field-wide"
            value={announceProgram}
            onChange={(e) => setAnnounceProgram(e.target.value)}
            placeholder="App address"
            aria-label="App address"
            required
          />
          <button className="btn" type="submit">
            Queue it
          </button>
        </form>
        {message("announce")}
      </section>

      <section className="admin-section" aria-labelledby="watch-h">
        <h2 id="watch-h">Add to the lab watchlist</h2>
        <p className="admin-hint">
          Watch an app address or a builder key by hand. Give at least one.
        </p>
        <form
          className="admin-form"
          onSubmit={(e) => {
            e.preventDefault();
            const programId = watchProgram.trim();
            const authority = watchAuthority.trim();
            const note = watchNote.trim();
            if (!programId && !authority) {
              say("watch", "Give an app address or a builder key", true);
              return;
            }
            void postJson("watch", "/admin/watchlist", {
              ...(programId ? { programId } : {}),
              ...(authority ? { authority } : {}),
              ...(note ? { note } : {}),
            }, "Added to the watchlist").then((ok) => {
              if (ok) {
                setWatchProgram("");
                setWatchAuthority("");
                setWatchNote("");
              }
            });
          }}
        >
          <input
            className="field field-wide"
            value={watchProgram}
            onChange={(e) => setWatchProgram(e.target.value)}
            placeholder="App address (optional)"
            aria-label="App address"
          />
          <input
            className="field field-wide"
            value={watchAuthority}
            onChange={(e) => setWatchAuthority(e.target.value)}
            placeholder="Builder key (optional)"
            aria-label="Builder key"
          />
          <input
            className="field field-wide"
            value={watchNote}
            onChange={(e) => setWatchNote(e.target.value)}
            placeholder="Note"
            aria-label="Note"
          />
          <button className="btn" type="submit">
            Watch it
          </button>
        </form>
        {message("watch")}
      </section>

      <section className="admin-section" aria-labelledby="config-h">
        <h2 id="config-h">Thresholds &amp; tone</h2>
        <p className="admin-hint">
          The newsroom&apos;s knobs, as JSON. Edit carefully, then save.
        </p>
        <textarea
          className="field"
          value={configText}
          onChange={(e) => setConfigText(e.target.value)}
          aria-label="Configuration JSON"
          spellCheck={false}
        />
        <div className="admin-form" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => void saveConfig()}>
            Save config
          </button>
          <button className="btn" onClick={() => void loadConfig(password)}>
            Reload
          </button>
        </div>
        {message("config")}
      </section>

      <section className="admin-section" aria-labelledby="log-h">
        <h2 id="log-h">Operator log</h2>
        <p className="admin-hint">Everything operators have done, newest first.</p>
        {logRows.length === 0 ? (
          <p className="admin-msg">The log is empty.</p>
        ) : (
          <div className="table-scroll">
            <table className="record-table">
              <thead>
                <tr>
                  {logColumns.map((col) => (
                    <th scope="col" key={col}>
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logRows.map((row, i) => (
                  <tr key={i}>
                    {logColumns.map((col) => (
                      <td key={col} className="plain">
                        {cellText(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
