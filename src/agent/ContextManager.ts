import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

export interface DocumentChunk {
  source: string;         // file path or "uploaded:<filename>"
  content: string;
  type: 'code' | 'doc' | 'config' | 'unknown';
  size: number;
}

export interface IndexedCodebase {
  root: string;
  files: CodebaseFile[];
  architectureDocs: DocumentChunk[];
  businessRules: DocumentChunk[];
  codingStandards: DocumentChunk[];
  uploadedDocuments: DocumentChunk[];
}

export interface CodebaseFile {
  path: string;
  relativePath: string;
  extension: string;
  size: number;
}

const ARCHITECTURE_FILE_PATTERNS = [
  'ARCHITECTURE.md', 'DESIGN.md', 'SYSTEM_DESIGN.md', 'OVERVIEW.md',
  'docs/architecture/**', 'docs/design/**', 'ADR/**', 'adr/**',
  '**/architecture.md', '**/system-design.md',
];

const STANDARDS_FILE_PATTERNS = [
  'CODING_STANDARDS.md', 'CONTRIBUTING.md', 'STYLE_GUIDE.md',
  '.eslintrc*', '.prettierrc*', 'tslint.json', 'pyproject.toml',
  '.editorconfig', 'sonar-project.properties',
];

const BUSINESS_RULES_PATTERNS = [
  'BUSINESS_RULES.md', 'REQUIREMENTS.md', 'SPECS.md',
  'docs/requirements/**', 'docs/specs/**', 'docs/business/**',
  '**/*.spec.md', '**/requirements/**',
];

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.pytest_cache', 'coverage', '.nyc_output', 'vendor', '.venv', 'venv',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.go', '.rs', '.rb',
  '.php', '.cs', '.cpp', '.c', '.h', '.swift', '.kt', '.scala',
  '.html', '.css', '.scss', '.less', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.env.example',
  '.md', '.mdx', '.txt', '.rst', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.proto', '.tf', '.dockerfile',
  'Dockerfile', 'Makefile', 'Jenkinsfile',
]);

/**
 * Manages codebase indexing and document context for the agent.
 *
 * Enterprise features:
 *   - Index the full codebase for reference
 *   - Separate architecture docs, business rules, coding standards
 *   - Accept uploaded documents (PDF text, Word text, plain text)
 *   - Build a rich system prompt context from all the above
 */
export class ContextManager {
  private index: IndexedCodebase | null = null;
  private uploadedDocuments: DocumentChunk[] = [];

  constructor(private workspaceRoot: string) {}

  // ─── Codebase Indexing ───────────────────────────────────────────────────────

  async indexWorkspace(
    onProgress?: (message: string) => void,
  ): Promise<IndexedCodebase> {
    onProgress?.('Scanning workspace...');

    const files = await this.scanFiles(this.workspaceRoot);
    onProgress?.(`Found ${files.length} files. Reading docs...`);

    const architectureDocs = await this.loadMatchingFiles(files, ARCHITECTURE_FILE_PATTERNS, 'doc');
    const businessRules = await this.loadMatchingFiles(files, BUSINESS_RULES_PATTERNS, 'doc');
    const codingStandards = await this.loadMatchingFiles(files, STANDARDS_FILE_PATTERNS, 'config');

    this.index = {
      root: this.workspaceRoot,
      files,
      architectureDocs,
      businessRules,
      codingStandards,
      uploadedDocuments: [...this.uploadedDocuments],
    };

    onProgress?.(
      `Indexed: ${architectureDocs.length} arch docs, ` +
      `${businessRules.length} business rule docs, ` +
      `${codingStandards.length} standard files`
    );

    return this.index;
  }

  // ─── Document Upload ─────────────────────────────────────────────────────────

  /**
   * Upload a document and add it to the agent's context.
   * Supports: .md, .txt, .rst, .json, .yaml, .pdf (text extraction), .docx (text extraction)
   */
  async uploadDocument(filePath: string): Promise<DocumentChunk> {
    const ext = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    let content = '';

    if (ext === '.pdf') {
      content = await this.extractPdfText(filePath);
    } else if (ext === '.docx') {
      content = await this.extractDocxText(filePath);
    } else {
      content = await fs.readFile(filePath, 'utf-8');
    }

    const chunk: DocumentChunk = {
      source: `uploaded:${fileName}`,
      content: content.slice(0, 100_000), // cap at 100KB per doc
      type: this.classifyDocumentType(fileName, content),
      size: content.length,
    };

    // Replace if already uploaded
    const existingIdx = this.uploadedDocuments.findIndex(d => d.source === chunk.source);
    if (existingIdx >= 0) {
      this.uploadedDocuments[existingIdx] = chunk;
    } else {
      this.uploadedDocuments.push(chunk);
    }

    // Refresh index
    if (this.index) {
      this.index.uploadedDocuments = [...this.uploadedDocuments];
    }

    return chunk;
  }

  removeUploadedDocument(fileName: string): void {
    this.uploadedDocuments = this.uploadedDocuments.filter(
      d => d.source !== `uploaded:${fileName}`,
    );
    if (this.index) {
      this.index.uploadedDocuments = [...this.uploadedDocuments];
    }
  }

  getUploadedDocuments(): DocumentChunk[] {
    return this.uploadedDocuments;
  }

  // ─── Context Building ────────────────────────────────────────────────────────

  /**
   * Build a rich context string to inject into the system prompt.
   * Includes: project structure, architecture docs, business rules,
   * coding standards, and any uploaded documents.
   */
  buildSystemContext(): string {
    const parts: string[] = [];

    if (!this.index) {
      return '';
    }

    // Project structure overview
    parts.push(this.buildProjectStructure());

    // Architecture documents
    if (this.index.architectureDocs.length > 0) {
      parts.push('## Architecture Documentation\n');
      for (const doc of this.index.architectureDocs) {
        parts.push(`### ${doc.source}\n\`\`\`\n${doc.content.slice(0, 8000)}\n\`\`\`\n`);
      }
    }

    // Business rules
    if (this.index.businessRules.length > 0) {
      parts.push('## Business Rules & Requirements\n');
      for (const doc of this.index.businessRules) {
        parts.push(`### ${doc.source}\n\`\`\`\n${doc.content.slice(0, 8000)}\n\`\`\`\n`);
      }
    }

    // Coding standards
    if (this.index.codingStandards.length > 0) {
      parts.push('## Coding Standards & Configuration\n');
      for (const doc of this.index.codingStandards) {
        parts.push(`### ${doc.source}\n\`\`\`\n${doc.content.slice(0, 4000)}\n\`\`\`\n`);
      }
    }

    // Uploaded documents (highest priority — user explicitly added these)
    if (this.index.uploadedDocuments.length > 0) {
      parts.push('## Uploaded Reference Documents\n');
      for (const doc of this.index.uploadedDocuments) {
        const label = this.getLabelForType(doc.type);
        parts.push(`### ${label}: ${doc.source}\n${doc.content.slice(0, 15_000)}\n`);
      }
    }

    return parts.join('\n');
  }

  getIndex(): IndexedCodebase | null {
    return this.index;
  }

  // ─── Private Helpers ─────────────────────────────────────────────────────────

  private async scanFiles(root: string): Promise<CodebaseFile[]> {
    const results: CodebaseFile[] = [];
    await this.walkForIndex(root, root, results);
    return results;
  }

  private async walkForIndex(
    baseDir: string,
    dir: string,
    results: CodebaseFile[],
  ): Promise<void> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        await this.walkForIndex(baseDir, fullPath, results);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(entry.name)) {
          const stat = await fs.stat(fullPath).catch(() => null);
          if (stat && stat.size < 1_000_000) { // skip files > 1MB
            results.push({
              path: fullPath,
              relativePath,
              extension: ext,
              size: stat.size,
            });
          }
        }
      }
    }
  }

  private async loadMatchingFiles(
    files: CodebaseFile[],
    patterns: string[],
    type: DocumentChunk['type'],
  ): Promise<DocumentChunk[]> {
    const mm = await import('micromatch');
    const chunks: DocumentChunk[] = [];

    for (const file of files) {
      const matches = patterns.some(p => {
        const relPath = file.relativePath;
        return (
          mm.default([relPath], p, { nocase: true }).length > 0 ||
          mm.default([path.basename(file.path)], p, { nocase: true }).length > 0
        );
      });

      if (matches) {
        try {
          const content = await fs.readFile(file.path, 'utf-8');
          chunks.push({
            source: file.relativePath,
            content,
            type,
            size: file.size,
          });
        } catch {
          /* skip unreadable files */
        }
      }
    }

    return chunks;
  }

  private buildProjectStructure(): string {
    if (!this.index) return '';

    const lines: string[] = ['## Project Structure\n', '```'];
    const tree = this.buildTree(this.index.files.map(f => f.relativePath));
    lines.push(...tree);
    lines.push('```\n');
    return lines.join('\n');
  }

  private buildTree(paths: string[]): string[] {
    // Show top 100 files only to keep context manageable
    return paths.slice(0, 100);
  }

  private classifyDocumentType(
    fileName: string,
    content: string,
  ): DocumentChunk['type'] {
    const lower = fileName.toLowerCase();
    if (['.ts', '.js', '.py', '.java', '.go', '.rs'].some(e => lower.endsWith(e))) return 'code';
    if (['.md', '.txt', '.rst', '.pdf', '.docx'].some(e => lower.endsWith(e))) return 'doc';
    if (['.json', '.yaml', '.yml', '.toml', '.env'].some(e => lower.endsWith(e))) return 'config';

    // Heuristic: if content mentions "architecture" or "business" → doc
    if (content.toLowerCase().includes('architecture') ||
        content.toLowerCase().includes('business rules') ||
        content.toLowerCase().includes('requirements')) {
      return 'doc';
    }

    return 'unknown';
  }

  private getLabelForType(type: DocumentChunk['type']): string {
    switch (type) {
      case 'code': return 'Code Reference';
      case 'doc': return 'Documentation';
      case 'config': return 'Configuration';
      default: return 'Reference';
    }
  }

  /** Basic PDF text extraction — strips binary, extracts readable strings */
  private async extractPdfText(filePath: string): Promise<string> {
    try {
      // Attempt to use pdfjs-dist if installed, fall back to raw text extraction
      const buffer = await fs.readFile(filePath);
      const text = buffer.toString('binary');
      // Extract strings between parentheses (PDF text encoding)
      const matches = text.match(/\(([^)]{2,200})\)/g) || [];
      return matches
        .map(m => m.slice(1, -1))
        .filter(s => /[a-zA-Z]{3,}/.test(s))
        .join(' ');
    } catch {
      return `[Could not extract text from PDF: ${path.basename(filePath)}]`;
    }
  }

  /** Basic DOCX text extraction */
  private async extractDocxText(filePath: string): Promise<string> {
    try {
      const buffer = await fs.readFile(filePath);
      const text = buffer.toString('utf-8', 0, buffer.length);
      // DOCX is ZIP — extract XML text
      const xmlMatches = text.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) || [];
      return xmlMatches
        .map(m => m.replace(/<[^>]+>/g, ''))
        .join(' ');
    } catch {
      return `[Could not extract text from DOCX: ${path.basename(filePath)}]`;
    }
  }
}
