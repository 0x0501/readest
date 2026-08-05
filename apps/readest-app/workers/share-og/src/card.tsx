// The unfurl card, compiled by satori's own JSX runtime (see
// `jsxImportSource` in tsconfig.json) — no React in this Worker.
//
// JSX form is XSS-safe by construction: satori escapes text content. No raw
// HTML strings cross the boundary.

// Cover-on-left composition. Asymmetric (anti-slop). Cover is the visual
// anchor; metadata sits to the right with strong vertical hierarchy.
export const withCoverCard = (cover: string, title: string, author: string | null) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: '#ffffff',
      padding: '64px',
      gap: '64px',
      fontFamily: 'serif',
    }}
  >
    <img
      src={cover}
      width={320}
      height={480}
      style={{
        objectFit: 'cover',
        border: '1px solid #e5e5e5',
        boxShadow: '0 6px 24px rgba(0,0,0,0.08)',
      }}
      alt=''
    />
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        gap: '24px',
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontSize: 56,
          fontWeight: 700,
          color: '#1a1a1a',
          lineHeight: 1.15,
          letterSpacing: '-0.02em',
        }}
      >
        {clamp(title, 90)}
      </div>
      {author && (
        <div style={{ fontSize: 32, color: '#525252', fontWeight: 400 }}>{clamp(author, 60)}</div>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div style={{ fontSize: 22, color: '#0066cc', fontWeight: 500 }}>Shared via Readest</div>
        <div style={{ fontSize: 18, color: '#a3a3a3' }}>readest.com</div>
      </div>
    </div>
  </div>
);

// Cover-less fallback (eng-review locked option A). Title becomes the visual
// anchor at display size. No placeholder rectangle, no procedural pattern.
export const textOnlyCard = (title: string, author: string | null) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      backgroundColor: '#ffffff',
      padding: '96px 80px',
      fontFamily: 'serif',
    }}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div
        style={{
          fontSize: 88,
          fontWeight: 700,
          color: '#1a1a1a',
          lineHeight: 1.05,
          letterSpacing: '-0.03em',
        }}
      >
        {clamp(title, 80)}
      </div>
      {author && (
        <div style={{ fontSize: 40, color: '#525252', fontWeight: 400 }}>{clamp(author, 60)}</div>
      )}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ fontSize: 26, color: '#0066cc', fontWeight: 500 }}>Shared via Readest</div>
      <div style={{ fontSize: 20, color: '#a3a3a3' }}>readest.com</div>
    </div>
  </div>
);

const clamp = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
