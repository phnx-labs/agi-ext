// Generate docs/reference.html and docs/reference.json: everything the extension
// contributes (package.json `contributes`) and every exported React component under
// ui/ with its props, the components that render it, and the webview pane it lives in.
// All of it is read from source: the manifest, and the TypeScript compiler over
// ui/tsconfig.json. The page is rendered by @phnx-labs/cli-docs, so it shares the
// look, sidebar tree and search of the CLI references.
//
//   bun scripts/gen-docs.ts            write both files
//   bun scripts/gen-docs.ts --check    exit 1 naming each stale file, write nothing

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { renderHtml, type CommandNode, type CommandOption } from '@phnx-labs/cli-docs';

const ROOT = resolve(import.meta.dir, '..');
const REGENERATE = 'bun scripts/gen-docs.ts';
const FILES = ['reference.html', 'reference.json'] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Manifest = { publisher: string; name: string; displayName: string; description: string; contributes: Record<string, Json> };

interface Prop {
  name: string;
  type: string;
  optional: boolean;
  description: string;
  default?: string;
}

interface Component {
  name: string;
  file: string;
  description: string;
  props: Prop[];
  /** Props declared by a dependency type (DOM attributes, Radix, ...), counted, not listed. */
  inherited: { count: number; from: string[] };
  /** Top-level declarations that render or reference it. */
  usedBy: string[];
  usedIn: string[];
}

/** Codepoint order: ICU collation differs between macOS and Linux and would make --check flap. */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => byCodepoint(key(a), key(b)));
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function asArray(value: Json | undefined): Record<string, Json>[] {
  return Array.isArray(value) ? (value as Record<string, Json>[]) : [];
}

function str(value: Json | undefined): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// The manifest: one node per contributed item, grouped by its `contributes` key.

function settingType(spec: Record<string, Json>): string {
  const type = Array.isArray(spec.type) ? spec.type.join(' | ') : str(spec.type);
  const items = spec.items as Record<string, Json> | undefined;
  return type === 'array' && items ? `array<${settingType(items)}>` : type;
}

/** Each contributes key the manifest may carry, mapped to its reference nodes. */
const CONTRIBUTES: Record<string, (value: Json, m: Manifest) => CommandNode[]> = {
  commands: (value, m) => asArray(value).map((cmd) => {
    const id = str(cmd.command);
    const keys = asArray(m.contributes.keybindings).filter((k) => k.command === id);
    const menus = Object.entries(m.contributes.menus as Record<string, Json> ?? {})
      .flatMap(([where, items]) => asArray(items).filter((i) => i.command === id).map((item) => ({ where, item })));
    const options: CommandOption[] = [
      ...keys.map((k) => option(str(k.key), `Keybinding${k.mac ? `, ${str(k.mac)} on macOS` : ''}${k.when ? `, when ${str(k.when)}` : ''}`)),
      ...menus.map(({ where, item }) => option(where, `Menu item${item.group ? ` in group ${str(item.group)}` : ''}${item.when ? `, when ${str(item.when)}` : ''}`)),
    ];
    const icon = cmd.icon === undefined ? '' : `Icon: ${typeof cmd.icon === 'string' ? cmd.icon : JSON.stringify(cmd.icon)}`;
    return node('commands', id, str(cmd.title), { options, notes: [icon, cmd.enablement ? `Enabled when ${str(cmd.enablement)}` : ''] });
  }),
  configuration: (value) => {
    const sections = Array.isArray(value) ? value : [value];
    return sections.flatMap((section) => Object.entries((section as Record<string, Json>).properties as Record<string, Record<string, Json>>))
      .map(([key, spec]) => node('configuration', key, str(spec.markdownDescription) || str(spec.description), {
        options: [{ ...option(settingType(spec), str(spec.scope) ? `Scope: ${str(spec.scope)}` : ''), ...(Array.isArray(spec.enum) ? { choices: spec.enum.map(String) } : {}), ...(spec.default === undefined ? {} : { defaultValue: JSON.stringify(spec.default) }) }],
        notes: [Array.isArray(spec.enumDescriptions) ? `Choices: ${(spec.enum as Json[]).map((e, i) => `${String(e)}: ${str((spec.enumDescriptions as Json[])[i])}`).join('; ')}` : ''],
      }));
  },
  configurationDefaults: (value) => Object.entries(value as Record<string, Json>).map(([key, v]) =>
    node('configurationDefaults', key, `Overrides the default of ${key}`, { options: [{ ...option(key, 'Default set by this extension'), defaultValue: JSON.stringify(v) }] })),
  customEditors: (value) => asArray(value).map((e) => node('customEditors', str(e.viewType), str(e.displayName), {
    options: asArray(e.selector).map((s) => option(str(s.filenamePattern), 'File pattern')),
    notes: [e.priority ? `Priority: ${str(e.priority)}` : ''],
  })),
  iconThemes: (value) => asArray(value).map((t) => node('iconThemes', str(t.id), str(t.label), { notes: [`Path: ${str(t.path)}`] })),
  keybindings: (value) => asArray(value).map((k) => node('keybindings', str(k.key), str(k.command), {
    options: [option(str(k.command), `Runs the command${k.mac ? `; ${str(k.mac)} on macOS` : ''}`)],
    notes: [k.when ? `When: ${str(k.when)}` : ''],
  })),
  menus: (value) => Object.entries(value as Record<string, Json>).map(([where, items]) => node('menus', where, `${asArray(items).length} items in the ${where} menu`, {
    options: asArray(items).map((i) => option(str(i.command), `${i.group ? `Group ${str(i.group)}` : 'No group'}${i.when ? `, when ${str(i.when)}` : ''}`)),
  })),
  views: (value) => Object.entries(value as Record<string, Json>).flatMap(([container, views]) => asArray(views).map((v) =>
    node('views', str(v.id), str(v.name), { notes: [`Container: ${container}`, v.type ? `Type: ${str(v.type)}` : '', v.when ? `When: ${str(v.when)}` : ''] }))),
  viewsContainers: (value) => Object.entries(value as Record<string, Json>).flatMap(([where, containers]) => asArray(containers).map((c) =>
    node('viewsContainers', str(c.id), str(c.title), { notes: [`Location: ${where}`, `Icon: ${str(c.icon)}`] }))),
};

function option(flags: string, description: string): CommandOption {
  return { flags, description, required: false, optional: false, variadic: false, negate: false };
}

function node(group: string, name: string, description: string, extra: { options?: CommandOption[]; notes?: string[] } = {}): CommandNode {
  const notes = (extra.notes ?? []).filter(Boolean).join('\n');
  return { name, path: `${group} ${name}`, aliases: [], description: oneLine(description), args: [], options: extra.options ?? [], ...(notes ? { notes } : {}), subcommands: [] };
}

function contributesNodes(m: Manifest): CommandNode[] {
  return sortBy(Object.keys(m.contributes), (k) => k).map((key) => {
    const map = CONTRIBUTES[key];
    if (!map) throw new Error(`package.json contributes.${key} has no reference mapping; add one to scripts/gen-docs.ts CONTRIBUTES`);
    const items = sortBy(map(m.contributes[key]!, m), (n) => n.name);
    const missing = items.filter((n) => !n.description);
    if (missing.length) throw new Error(`contributes.${key} entries without a title or description: ${missing.map((n) => n.name).join(', ')}`);
    return { name: key, path: key, aliases: [], description: `${items.length} entries in package.json contributes.${key}`, args: [], options: [], subcommands: items };
  });
}

// ---------------------------------------------------------------------------
// The UI: exported components, their props, and the render graph.

const rel = (file: string) => relative(ROOT, file).split('\\').join('/');

/** The top-level declaration a node sits in: the component that renders it, or the module itself. */
function ownerKey(n: ts.Node): string {
  let top = n;
  while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
  const file = rel(n.getSourceFile().fileName);
  if (ts.isFunctionDeclaration(top) || ts.isClassDeclaration(top)) return `${file}#${top.name?.text ?? 'default'}`;
  // `export default X` only names an export; `export default Extension.create({...})` is a declaration.
  if (ts.isExportAssignment(top) && !ts.isIdentifier(top.expression)) return `${file}#default`;
  if (ts.isVariableStatement(top)) {
    const first = top.declarationList.declarations[0];
    if (first && ts.isIdentifier(first.name)) return `${file}#${first.name.text}`;
  }
  return `${file}#<module>`;
}

function declKey(decl: ts.Declaration): string | undefined {
  const file = rel(decl.getSourceFile().fileName);
  if (file.startsWith('..') || file.includes('node_modules/')) return undefined;
  const name = ts.getNameOfDeclaration(decl);
  if (name && ts.isIdentifier(name)) return `${file}#${name.text}`;
  if (ts.isFunctionDeclaration(decl) || ts.isExportAssignment(decl)) return `${file}#default`;
  return undefined;
}

function isTopLevel(decl: ts.Declaration): boolean {
  const statement = ts.isVariableDeclaration(decl) ? decl.parent?.parent : decl;
  return statement?.parent !== undefined && ts.isSourceFile(statement.parent);
}

/** The function a component declaration runs, unwrapping forwardRef(...) and memo(...). */
function componentFunction(decl: ts.Declaration): ts.SignatureDeclaration | undefined {
  let expr: ts.Node | undefined = decl;
  if (ts.isVariableDeclaration(decl)) expr = decl.initializer;
  while (expr && ts.isCallExpression(expr)) expr = expr.arguments[0];
  return expr && (ts.isFunctionDeclaration(expr) || ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) ? expr : undefined;
}

function destructuredDefaults(fn: ts.SignatureDeclaration | undefined): Map<string, string> {
  const defaults = new Map<string, string>();
  const param = fn?.parameters[0];
  if (param && ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      const key = el.propertyName ?? el.name;
      if (el.initializer && ts.isIdentifier(key)) defaults.set(key.text, oneLine(el.initializer.getText()));
    }
  }
  return defaults;
}

function docOf(symbol: ts.Symbol, checker: ts.TypeChecker): string {
  return oneLine(ts.displayPartsToString(symbol.getDocumentationComment(checker)));
}

function isJsxReturn(sig: ts.Signature, checker: ts.TypeChecker): boolean {
  return /\b(JSX\.Element|ReactElement|ReactNode|Element)\b/.test(checker.typeToString(sig.getReturnType(), undefined, ts.TypeFormatFlags.NoTruncation));
}

function propsOf(symbol: ts.Symbol, decl: ts.Declaration, checker: ts.TypeChecker): Pick<Component, 'props' | 'inherited'> {
  const sig = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures()[0];
  const param = sig?.getParameters()[0];
  if (!param) return { props: [], inherited: { count: 0, from: [] } };
  const defaults = destructuredDefaults(componentFunction(decl));
  const props: Prop[] = [];
  const from = new Set<string>();
  let count = 0;
  for (const prop of checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(param, decl))) {
    const decls = prop.getDeclarations() ?? [];
    const own = decls.find((d) => !d.getSourceFile().fileName.includes('/node_modules/'));
    if (!own) {
      count++;
      for (const d of decls) if (ts.isInterfaceDeclaration(d.parent) || ts.isTypeAliasDeclaration(d.parent)) from.add(d.parent.name.text);
      continue;
    }
    const typeNode = (ts.isPropertySignature(own) || ts.isPropertyDeclaration(own)) ? own.type : undefined;
    const type = typeNode ? typeNode.getText() : checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, decl), decl, ts.TypeFormatFlags.NoTruncation);
    const dflt = defaults.get(prop.name);
    props.push({
      name: prop.name,
      type: oneLine(type),
      optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      description: docOf(prop, checker),
      ...(dflt === undefined ? {} : { default: dflt }),
    });
  }
  return { props: sortBy(props, (p) => p.name), inherited: { count, from: [...from].sort(byCodepoint) } };
}

/**
 * Each ui/<root>/ bundle mapped to the webview that loads it, read from the extension host source.
 * A registration claims the bundles its own file loads and those loaded by the src modules it
 * imports directly (settings.vscode.ts registers the Fleet panel; settingsWebview.ts builds its HTML).
 */
function webviewHosts(manifest: Manifest): Map<string, string> {
  const hosts = new Map<string, string>();
  const labels = new Map<string, string>([
    ...asArray(manifest.contributes.customEditors).map((e) => [str(e.viewType), `custom editor "${str(e.displayName)}"`] as [string, string]),
    ...Object.values(manifest.contributes.views as Record<string, Json> ?? {}).flatMap((v) => asArray(v).map((x) => [str(x.id), `view "${str(x.name)}"`] as [string, string])),
  ]);
  const walkDir = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkDir(join(dir, e.name)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [join(dir, e.name)] : []);
  const files = new Map<string, { bundles: Set<string>; registrations: { viewType: string; title?: string }[]; imports: string[] }>();
  for (const file of walkDir(join(ROOT, 'src')).sort(byCodepoint)) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const consts = new Map<string, string>();
    const bundles = new Set<string>();
    const imports = sf.statements
      .filter((st): st is ts.ImportDeclaration => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text.startsWith('.'))
      .map((st) => resolve(dirname(file), (st.moduleSpecifier as ts.StringLiteral).text) + '.ts');
    const registrations: { viewType: string; title?: string }[] = [];
    const value = (e: ts.Expression | undefined) => !e ? undefined : ts.isStringLiteralLike(e) ? e.text : ts.isIdentifier(e) ? consts.get(e.text) ?? e.text : undefined;
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteralLike(n.initializer)) consts.set(n.name.text, n.initializer.text);
      ts.forEachChild(n, collect);
    };
    collect(sf);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const args = n.arguments.map((a) => (ts.isStringLiteralLike(a) ? a.text : undefined));
        const at = args.findIndex((a, i) => a === 'out' && args[i + 1] === 'ui' && args[i + 2]);
        if (at >= 0) bundles.add(args[at + 2]!);
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : '';
        if (callee === 'createWebviewPanel' || callee === 'registerCustomEditorProvider' || callee === 'registerWebviewViewProvider') {
          registrations.push({ viewType: value(n.arguments[0]) ?? '', title: callee === 'createWebviewPanel' ? value(n.arguments[1]) : undefined });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    files.set(file, { bundles, registrations, imports });
  }
  for (const { bundles, registrations, imports } of files.values()) {
    const label = registrations.map((r) => labels.get(r.viewType) ?? `webview panel "${r.title ?? r.viewType}" (${r.viewType})`).join(', ');
    if (!label) continue;
    for (const bundle of [bundles, ...imports.map((i) => files.get(i)?.bundles ?? [])].flatMap((b) => [...b])) hosts.set(bundle, label);
  }
  return hosts;
}

function uiComponents(manifest: Manifest): Component[] {
  const uiDir = join(ROOT, 'ui');
  // Without ui's dependencies every React type resolves to `any` and the props come out wrong.
  if (!existsSync(join(uiDir, 'node_modules', '@types', 'react'))) throw new Error('ui/ dependencies are not installed: run `(cd ui && bun install)` first');
  const config = ts.readConfigFile(join(uiDir, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, uiDir);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const graphSources = program.getSourceFiles()
    .filter((sf) => rel(sf.fileName).startsWith('ui/') && !sf.fileName.includes('/node_modules/') && !/\.test\.tsx?$/.test(sf.fileName))
    .sort((a, b) => byCodepoint(a.fileName, b.fileName));
  const sources = graphSources.filter((sf) => sf.fileName.endsWith('.tsx'));

  // Use graph: each top-level declaration -> the top-level ui/ declarations it references.
  // References, not only JSX tags: memo(FeedItemImpl) and the editor's
  // ReactRenderer(SlashCommandsList) mount components without a tag.
  const edges = new Map<string, Set<string>>();
  const display = new Map<string, string>();
  for (const sf of graphSources) {
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        let sym = checker.getSymbolAtLocation(n);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
        const decl = sym?.declarations?.[0];
        const target = decl && isTopLevel(decl) ? declKey(decl) : undefined;
        const owner = ownerKey(n);
        if (target && target !== owner) {
          if (!edges.has(owner)) edges.set(owner, new Set());
          edges.get(owner)!.add(target);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const reach = new Map<string, Set<string>>();
  const reachable = (key: string): Set<string> => {
    const cached = reach.get(key);
    if (cached) return cached;
    const seen = new Set<string>([key]);
    reach.set(key, seen);
    for (const next of edges.get(key) ?? []) for (const k of reachable(next)) seen.add(k);
    return seen;
  };

  // Webview roots are ui/<bundle>/main.tsx; what they render is the app shell, and what the
  // shell renders directly is a pane.
  const hosts = webviewHosts(manifest);
  const usedIn = new Map<string, Set<string>>();
  const mark = (key: string, where: string) => (usedIn.get(key) ?? usedIn.set(key, new Set()).get(key)!).add(where);
  for (const sf of sources.filter((s) => basename(s.fileName) === 'main.tsx')) {
    const bundle = basename(dirname(sf.fileName));
    const view = hosts.get(bundle);
    if (!view) throw new Error(`ui/${bundle} has no webview in src/ that loads out/ui/${bundle}`);
    for (const shell of edges.get(`${rel(sf.fileName)}#<module>`) ?? []) {
      const shellName = shell.split('#')[1]!;
      mark(shell, `${view} › ${shellName}`);
      for (const pane of edges.get(shell) ?? []) {
        for (const k of reachable(pane)) mark(k, `${view} › ${pane.split('#')[1]!}`);
      }
    }
  }

  const components: Component[] = [];
  for (const sf of sources) {
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const decl = symbol.declarations?.[0];
      if (!decl || decl.getSourceFile() !== sf) continue;
      const key = declKey(decl);
      const name = exported.name === 'default' ? key?.split('#')[1] ?? basename(sf.fileName, '.tsx') : exported.name;
      if (!key || !/^[A-Z]/.test(name)) continue;
      const sig = checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures()[0];
      if (!sig || !isJsxReturn(sig, checker)) continue;
      display.set(key, name);
      components.push({
        name,
        file: rel(sf.fileName),
        description: docOf(symbol, checker),
        ...propsOf(symbol, decl, checker),
        usedBy: [],
        usedIn: [...(usedIn.get(key) ?? [])].sort(byCodepoint),
      });
    }
  }
  const byKey = new Map(components.map((c) => [`${c.file}#${c.name}`, c]));
  for (const [owner, targets] of edges) {
    const [file, name] = owner.split('#') as [string, string];
    // A module-level statement (`X.displayName = ...`, `export default X`) is not a use,
    // except in a webview entry, where it is the mount.
    if (name === '<module>' && basename(file) !== 'main.tsx') continue;
    const label = name === '<module>' ? file : name === 'default' ? `default export of ${file}` : `${name} (${file})`;
    for (const t of targets) byKey.get(`${t.split('#')[0]}#${display.get(t) ?? ''}`)?.usedBy.push(label);
  }
  for (const c of components) c.usedBy = [...new Set(c.usedBy)].sort(byCodepoint);
  return sortBy(components, (c) => `${c.file}#${c.name}`);
}

function componentNodes(components: Component[]): CommandNode {
  const dirs = new Map<string, Component[]>();
  for (const c of components) {
    const dir = dirname(c.file);
    dirs.set(dir, [...(dirs.get(dir) ?? []), c]);
  }
  const subcommands = sortBy([...dirs.keys()], (d) => d).map((dir): CommandNode => ({
    name: dir,
    path: `components ${dir}`,
    aliases: [],
    description: `${dirs.get(dir)!.length} exported components in ${dir}/`,
    args: [],
    options: [],
    subcommands: sortBy(dirs.get(dir)!, (c) => c.name).map((c) => ({
      name: c.name,
      path: `components ${dir} ${c.name}`,
      aliases: [],
      description: c.description || `Exported from ${c.file}.`,
      args: [],
      options: c.props.map((p) => ({ ...option(`${p.name}${p.optional ? '?' : ''}: ${p.type}`, p.description), ...(p.default === undefined ? {} : { defaultValue: p.default }) })),
      notes: [
        `File: ${c.file}`,
        `Pane: ${c.usedIn.join('; ') || 'not reachable from any webview entry'}`,
        `Used by: ${c.usedBy.join(', ') || 'nothing in ui/'}`,
        c.inherited.count ? `Also accepts ${c.inherited.count} props declared by ${c.inherited.from.join(', ') || 'dependency types'}` : '',
      ].filter(Boolean).join('\n'),
      subcommands: [],
    })),
  }));
  return { name: 'components', path: 'components', aliases: [], description: `${components.length} exported React components under ui/, with their props`, args: [], options: [], subcommands };
}

// ---------------------------------------------------------------------------

function build(): { files: Record<(typeof FILES)[number], string>; counts: Record<string, number> } {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Manifest;
  const contributes = contributesNodes(manifest);
  const components = uiComponents(manifest);
  const tree = [...contributes, componentNodes(components)];
  const count = (key: string) => contributes.find((n) => n.name === key)?.subcommands.length ?? 0;
  const counts = {
    commands: count('commands'),
    settings: count('configuration'),
    keybindings: count('keybindings'),
    menuItems: contributes.find((n) => n.name === 'menus')?.subcommands.reduce((n, menu) => n + menu.options.length, 0) ?? 0,
    views: count('views'),
    viewContainers: count('viewsContainers'),
    customEditors: count('customEditors'),
    components: components.length,
    props: components.reduce((n, c) => n + c.props.length, 0),
  };
  const bin = manifest.name;
  const options = {
    bin,
    title: `${manifest.displayName} extension reference`,
    description: `${manifest.description} Every contribution in package.json and every exported UI component under ui/, generated from the manifest and the TypeScript types.`,
    regenerate: REGENERATE,
  };
  const json = {
    schemaVersion: 1,
    extension: `${manifest.publisher}.${manifest.name}`,
    generatedBy: REGENERATE,
    counts,
    contributes: Object.fromEntries(sortBy(Object.keys(manifest.contributes), (k) => k).map((k) => [k, manifest.contributes[k]!])),
    components,
  };
  return { files: { 'reference.html': renderHtml(tree, undefined, options), 'reference.json': JSON.stringify(json, null, 2) + '\n' }, counts };
}

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false }, 'out-dir': { type: 'string' } }, strict: true });
const outDir = values['out-dir'] ? resolve(values['out-dir']) : join(ROOT, 'docs');
const { files, counts } = build();
const stale: string[] = [];
if (!values.check) mkdirSync(outDir, { recursive: true });
for (const file of FILES) {
  const target = join(outDir, file);
  if (values.check) {
    if (!existsSync(target) || readFileSync(target, 'utf8') !== files[file]) stale.push(file);
  } else {
    writeFileSync(target, files[file]);
  }
}
if (stale.length) {
  console.error(`extension reference is stale: ${stale.join(', ')}\nRegenerate with: ${REGENERATE}`);
  process.exit(1);
}
console.log(`${values.check ? 'checked' : 'wrote'} ${FILES.join(', ')} in ${rel(outDir) || '.'} (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})`);
