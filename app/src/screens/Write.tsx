const today = new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
  new Date(),
)

export function Write() {
  return (
    <div className="screen">
      <article className="page" aria-label="Journal page">
        <header className="page-head">
          <h1 className="page-date">{today}</h1>
          <span className="pill">
            <span className="pill-dot" aria-hidden />
            Daily
          </span>
          <span className="pill" aria-label="Language: English">
            EN
          </span>
        </header>
        <div dir="auto" style={{ unicodeBidi: 'plaintext' }}>
          <p dir="auto">
            Read Alma 32 this morning. The seed comparison landed differently today, slower and warmer than I
            remembered.
          </p>
          <p dir="auto">الحمد لله على كل حال. كتبت هذه الفقرة بالعربية داخل صفحة إنجليزية، ويجب أن تتدفق من اليمين إلى اليسار.</p>
          <p dir="auto">
            A mixed line: الحمد لله — then back to English, and the cursor should not jump around.
          </p>
        </div>
        <p className="save-status">Saved</p>
      </article>
      <p className="stub-note" style={{ textAlign: 'center' }}>
        Sample text. The Tiptap editor and autosave arrive in phase 2.
      </p>
    </div>
  )
}
