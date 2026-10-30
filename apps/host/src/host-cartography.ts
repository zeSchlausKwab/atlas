/** Decorative map symbols; no remote imagery or geographic data required. */
export function workbenchIcon(section: string) {
  const paths: Record<string, string> = {
    library: '<path d="m3 8 9-5 9 5-9 5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
    prepare:
      '<path d="M5 5h14v14H5z" stroke-dasharray="3 3"/><path d="M3 3h4v4H3zM17 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4z" fill="currentColor" stroke="none"/>',
    imports: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
    federation:
      '<path d="m6 7 12 10M6 7l12-2M6 7l-1 12 13-2M18 5v12"/><g fill="var(--paper)"><circle cx="6" cy="7" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="17" r="3"/><circle cx="5" cy="19" r="3"/></g>',
    operations:
      '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/><path d="m10 10 4 4"/>',
  };
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${paths[section] ?? paths.library}</svg>`;
}

// A schematic map, intentionally without place names or fabricated coordinates.
export const cartography = `<div class="workbench-cartography" aria-hidden="true">
<svg viewBox="0 0 320 210" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M0 0h320v210H0z" fill="#f8f4f0"/>
  <path d="M220-10c-33 44-17 62-36 87s-47 25-54 57 15 45-22 86h53c23-36 8-60 23-79s43-23 49-57S233 31 267-10" fill="#9ebdff"/>
  <path d="m10 14 103-9 18 45-32 38-91-9zM233 116l83-22 13 100-116 16 4-51z" fill="#d8e8c8" stroke="#b4cba0"/>
  <path d="m25 30 67-9 17 29-25 23-57-8zM243 133l57-15 7 60-79 16 11-35z" stroke="#c3d5b3"/>
  <g fill="#dcd9d4" stroke="#cbc7c0" stroke-width=".6"><path d="m17 107 31-9 10 28-32 9zM64 93l33-10 10 30-33 11zM33 155l29-8 10 24-29 9zM80 139l28-8 9 24-29 9zM269 17l32-3 3 31-32 4zM254 62l46-4 3 21-45 5z"/></g>
  <path d="M-10 96 118 62m-86 153L-8 109M65 215 16 82m110 133L80 66M251-5l-7 113M295-5l-6 116M212 161l115-22" stroke="#d7d2ca" stroke-width="7"/>
  <path d="M-10 96 118 62m-86 153L-8 109M65 215 16 82m110 133L80 66M251-5l-7 113M295-5l-6 116M212 161l115-22" stroke="#fff" stroke-width="5"/>
  <path d="M-10 153 146 106 204 104 330 87" stroke="#e9ac77" stroke-width="12"/>
  <path d="M-10 153 146 106 204 104 330 87" stroke="#ffdaa6" stroke-width="8"/>
  <path d="M129-8 157 59 145 114 181 220" stroke="#e9ac77" stroke-width="10"/>
  <path d="M129-8 157 59 145 114 181 220" stroke="#fff0ba" stroke-width="6"/>
  <path d="M56 47h206v128H56z" fill="#ffffff10" stroke="#6688b2" stroke-width="1.5" stroke-dasharray="5 5"/>
  <g fill="#fff" stroke="#47739d" stroke-width="2"><circle cx="56" cy="47" r="4"/><circle cx="262" cy="47" r="4"/><circle cx="262" cy="175" r="4"/><circle cx="56" cy="175" r="4"/></g>
  <path d="M104 113c-17-21-22-29-22-37a22 22 0 0 1 44 0c0 8-5 16-22 37z" fill="#47739d" stroke="#fff" stroke-width="3"/>
  <circle cx="104" cy="76" r="7" fill="#fff"/>
</svg></div>`;
