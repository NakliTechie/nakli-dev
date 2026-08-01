(function (root) {
  'use strict';

  const LANGUAGE_BY_EXT = Object.freeze({
    js:'JavaScript', mjs:'JavaScript', cjs:'JavaScript', jsx:'JavaScript JSX',
    ts:'TypeScript', tsx:'TypeScript JSX', json:'JSON', jsonl:'JSON Lines',
    html:'HTML', htm:'HTML', css:'CSS', scss:'SCSS', less:'Less',
    md:'Markdown', markdown:'Markdown', txt:'Plain text', csv:'CSV', tsv:'TSV',
    yaml:'YAML', yml:'YAML', toml:'TOML', ini:'INI', conf:'Config', env:'Environment',
    py:'Python', rb:'Ruby', php:'PHP', java:'Java', kt:'Kotlin', kts:'Kotlin',
    go:'Go', rs:'Rust', c:'C', h:'C header', cc:'C++', cpp:'C++', hpp:'C++ header',
    cs:'C#', swift:'Swift', dart:'Dart', sql:'SQL', sh:'Shell', bash:'Shell', zsh:'Shell',
    xml:'XML', svg:'SVG', vue:'Vue', svelte:'Svelte', astro:'Astro', gql:'GraphQL',
    graphql:'GraphQL', properties:'Properties', gitignore:'Git ignore', editorconfig:'EditorConfig',
  });

  function normalisePath(value) {
    const path = String(value || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some(part => part === '.' || part === '..')) {
      throw new Error('Use a relative project path without . or .. segments');
    }
    return parts.join('/');
  }

  function detectLanguage(path) {
    const name = String(path || '').split('/').pop() || '';
    const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : name.toLowerCase();
    return LANGUAGE_BY_EXT[ext] || 'Plain text';
  }

  function recoveryKey(location, identity) {
    return `${String(location || 'browser')}::${String(identity || '')}`;
  }

  function normaliseWorkspace(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const open = Array.isArray(input.open)
      ? input.open.filter(path => typeof path === 'string').map(path => {
          try { return normalisePath(path); } catch (_) { return null; }
        }).filter(Boolean)
      : [];
    const active = typeof input.active === 'string' && open.includes(input.active)
      ? input.active
      : (open[0] || null);
    return { version:1, open:[...new Set(open)], active };
  }

  function lineColumn(text, offset) {
    const before = String(text || '').slice(0, Math.max(0, Number(offset) || 0));
    const lines = before.split('\n');
    return { line:lines.length, column:(lines.at(-1) || '').length + 1 };
  }

  function searchText(text, query, options) {
    const source = String(text || '');
    const needle = String(query || '');
    if (!needle) return [];
    const flags = options?.caseSensitive ? 'g' : 'gi';
    const pattern = options?.regex
      ? new RegExp(needle, flags)
      : new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    const matches = [];
    let match;
    while ((match = pattern.exec(source)) && matches.length < 1000) {
      matches.push({ index:match.index, length:Math.max(1, match[0].length) });
      if (!match[0].length) pattern.lastIndex += 1;
    }
    return matches;
  }

  root.EditorCore = Object.freeze({
    LANGUAGE_BY_EXT,
    normalisePath,
    detectLanguage,
    recoveryKey,
    normaliseWorkspace,
    lineColumn,
    searchText,
  });
})(typeof window !== 'undefined' ? window : globalThis);
