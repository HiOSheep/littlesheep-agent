// @littlesheep/app - workspace-file-routing.ts
// Pure workspace file routing helpers shared by the Local App API and tests.

export type WorkspaceFileSurface =
  | 'builtinEditor'
  | 'imagePreview'
  | 'pdfPreview'
  | 'documentCard'
  | 'sniffText'

export const WORKSPACE_MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx'])
export const WORKSPACE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg'])
export const WORKSPACE_PDF_EXTS = new Set(['.pdf'])
export const WORKSPACE_OFFICE_EXTS = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.dot',
  '.dotx',
  '.ppt',
  '.pptx',
  '.pptm',
  '.pps',
  '.ppsx',
  '.pot',
  '.potx',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.xlt',
  '.xltx',
  '.odt',
  '.odp',
  '.ods',
])

const WORKSPACE_TEXT_EXTS = new Set([
  '.txt',
  '.log',
  '.lock',
  '.properties',
  '.conf',
  '.config',
  '.cfg',
  '.json',
  '.jsonc',
  '.code-workspace',
  '.ipynb',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.editorconfig',
  '.env',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hpp',
  '.hh',
  '.hxx',
  '.ipp',
  '.cs',
  '.php',
  '.rb',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.bat',
  '.cmd',
  '.ps1',
  '.psm1',
  '.psd1',
  '.ps1xml',
  '.sql',
  '.csv',
  '.tsv',
  '.http',
  '.rest',
  '.graphql',
  '.gql',
  '.proto',
  '.prisma',
  '.sol',
  '.vue',
  '.svelte',
  '.astro',
  '.lua',
  '.kt',
  '.kts',
  '.swift',
  '.dart',
  '.zig',
  '.nim',
  '.cr',
  '.r',
  '.jl',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.scala',
  '.sc',
  '.clj',
  '.cljs',
  '.edn',
  '.hs',
  '.lhs',
  '.ml',
  '.mli',
  '.fs',
  '.fsi',
  '.fsx',
  '.vb',
  '.vbs',
  '.m',
  '.mm',
  '.pl',
  '.pm',
  '.t',
  '.tcl',
  '.sv',
  '.svh',
  '.v',
  '.vh',
  '.gradle',
  '.groovy',
  '.hcl',
  '.tf',
  '.tfvars',
  '.bicep',
  '.cue',
  '.rego',
  '.mod',
  '.sum',
  '.cshtml',
  '.razor',
  '.hbs',
  '.handlebars',
  '.mustache',
  '.liquid',
  '.twig',
  '.njk',
  '.pug',
  '.jade',
  '.sln',
  '.csproj',
  '.fsproj',
  '.vbproj',
  '.props',
  '.targets',
  '.xaml',
  '.gitignore',
  '.dockerignore',
])

const WORKSPACE_TEXT_FILE_NAMES = new Set([
  '.editorconfig',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.nvmrc',
  '.yarnrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.stylelintrc',
  '.browserslistrc',
  '.gitignore',
  '.dockerignore',
  '.gitattributes',
  '.gitmodules',
  'agents',
  'dockerfile',
  'containerfile',
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
  'makefile',
  'cmakelists.txt',
  'gemfile',
  'rakefile',
  'procfile',
  'justfile',
  'earthfile',
  'vagrantfile',
  'jenkinsfile',
  'brewfile',
  'pipfile',
  'poetry.lock',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'readme',
  'license',
  'changelog',
  'authors',
  'contributors',
])

export function isWorkspaceTextLikeFile(lowerName: string, ext: string): boolean {
  return WORKSPACE_TEXT_EXTS.has(ext) || WORKSPACE_TEXT_FILE_NAMES.has(lowerName)
}

export function classifyWorkspaceFileSurface(lowerName: string, ext: string): WorkspaceFileSurface {
  if (WORKSPACE_IMAGE_EXTS.has(ext)) return 'imagePreview'
  if (WORKSPACE_PDF_EXTS.has(ext)) return 'pdfPreview'
  if (WORKSPACE_OFFICE_EXTS.has(ext)) return 'documentCard'
  if (WORKSPACE_MARKDOWN_EXTS.has(ext) || isWorkspaceTextLikeFile(lowerName, ext)) return 'builtinEditor'
  return 'sniffText'
}

export function previewLanguageForWorkspaceFile(lowerName: string, ext: string): string {
  if (lowerName === 'dockerfile') return 'dockerfile'
  if (lowerName === 'containerfile') return 'dockerfile'
  if (lowerName === 'makefile') return 'makefile'
  if (lowerName === 'justfile') return 'makefile'
  if (lowerName === 'cmakelists.txt') return 'cmake'
  if (lowerName === 'go.mod') return 'go'
  if (lowerName === 'go.sum') return 'text'
  if (lowerName === '.editorconfig') return 'ini'
  const normalized = ext.replace(/^\./, '')
  if (normalized === 'md') return 'markdown'
  if (normalized === 'jsonc' || normalized === 'code-workspace' || normalized === 'ipynb') return 'json'
  if (normalized === 'ts' || normalized === 'tsx' || normalized === 'mts' || normalized === 'cts') return 'typescript'
  if (normalized === 'js' || normalized === 'jsx' || normalized === 'mjs' || normalized === 'cjs') return 'javascript'
  if (normalized === 'yml') return 'yaml'
  if (normalized === 'htm') return 'html'
  if (normalized === 'env') return 'ini'
  if (normalized === 'ps1' || normalized === 'psm1' || normalized === 'psd1' || normalized === 'ps1xml') return 'powershell'
  if (normalized === 'sh' || normalized === 'bash' || normalized === 'zsh' || normalized === 'fish') return 'shell'
  if (normalized === 'cmd' || normalized === 'bat') return 'bat'
  if (normalized === 'vue' || normalized === 'svelte' || normalized === 'astro') return 'html'
  if (normalized === 'c' || normalized === 'cc' || normalized === 'cpp' || normalized === 'cxx') return 'cpp'
  if (normalized === 'h' || normalized === 'hpp' || normalized === 'hh' || normalized === 'hxx' || normalized === 'ipp') return 'cpp'
  if (normalized === 'm' || normalized === 'mm') return 'objective-c'
  if (normalized === 'pl' || normalized === 'pm' || normalized === 't') return 'perl'
  if (normalized === 'sv' || normalized === 'svh' || normalized === 'v' || normalized === 'vh') return 'systemverilog'
  if (normalized === 'hbs' || normalized === 'handlebars' || normalized === 'mustache') return 'handlebars'
  if (normalized === 'cshtml' || normalized === 'razor') return 'razor'
  if (normalized === 'tf' || normalized === 'tfvars') return 'hcl'
  if (normalized === 'lock' || normalized === 'mod' || normalized === 'sum') return 'text'
  return normalized || 'text'
}
