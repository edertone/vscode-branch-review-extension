import { readFileSync } from 'fs';
import { join } from 'path';

export type AnalysisProfileId = 'general-purpose' | 'typescript' | 'java' | 'angular' | 'playwright';

export interface AnalysisProfile {
  id: AnalysisProfileId;
  label: string;
  /** Default guide sent to the model. Users may edit it before each run. */
  guide: string;
  /** Changed paths (repository-relative) that belong to this profile. */
  include: RegExp[];
  exclude: RegExp[];
}

/** Fixed output contract appended to every guide so reports stay parseable and comparable. */
export const OUTPUT_CONTRACT = `## Output format

Respond in Markdown with exactly these level-2 sections, in this order:

## Summary
Two to five sentences: overall risk, the most important problems, and whether the change is safe to merge.

## Findings
One item per finding, ordered by severity (Critical, High, Medium, Low). Each item has:
- **Severity**: Critical, High, Medium, or Low.
- **Category**: bug, security, concurrency, data, performance, regression, architecture, code smell, testing, or maintainability.
- **Location**: path and new-file line number taken from the hunk header (or "removed code" for deletions).
- **Evidence**: the relevant changed lines, quoted briefly.
- **Impact**: what goes wrong and when.
- **Recommendation**: a concrete fix.
- Mark any finding that depends on code outside the provided patches as "Needs verification".
If there are no findings, write "No findings."

## Code smells
Bullet list of smells in the changed code, each with its location. Write "None found." if there are none.

## Architecture
Bullet list of design and architectural concerns introduced or worsened by the changes. Write "None found." if there are none.

## Quality metrics
A short table or list with your estimates for the changed code: method complexity hotspots, size of changed classes or components, new duplication, coupling, and whether the changed behaviour is covered by tests. State clearly when a metric is an estimate.

## Not reviewed
List the files or hunks you could not assess properly (for example truncated or missing patches, or code that is needed but not provided).

Use only the provided changes and their stated context. Do not invent line numbers, file names, or APIs. Do not report issues that a formatter or linter would fix automatically.`;

const PROFILE_GUIDES_DIR = join(__dirname, '..', 'src', 'analysis-profiles');

function loadGuide(fileName: string): string {
  return readFileSync(join(PROFILE_GUIDES_DIR, fileName), 'utf8').trim();
}

export const ANALYSIS_PROFILES: readonly AnalysisProfile[] = [
  {
    id: 'general-purpose',
    label: 'General Purpose',
    guide: loadGuide('general-purpose.md'),
    include: [/.+/],
    exclude: [/(^|\/)(.git|target|build|out|dist|node_modules|coverage)\//],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    guide: loadGuide('typescript.md'),
    include: [
      /\.(ts|tsx|mts|cts)$/i,
      /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]*\.lock)$/i,
    ],
    exclude: [/(^|\/)(node_modules|dist|coverage|out)\//, /\.d\.ts$/i],
  },
  {
    id: 'java',
    label: 'Java',
    guide: loadGuide('java.md'),
    include: [/\.(java|kt|kts|gradle|properties|ya?ml|xml|sql)$/i],
    exclude: [/(^|\/)(target|build|out|dist|node_modules)\//],
  },
  {
    id: 'angular',
    label: 'Angular',
    guide: loadGuide('angular.md'),
    include: [
      /\.(ts|html|scss|css|less)$/i,
      /(^|\/)(angular\.json|package\.json|tsconfig[^/]*\.json)$/,
    ],
    exclude: [
      /(^|\/)(node_modules|dist|coverage|\.angular)\//,
      /\.min\.(js|css)$/i,
    ],
  },
  {
    id: 'playwright',
    label: 'Playwright',
    guide: loadGuide('playwright.md'),
    include: [
      /(^|\/)(?:tests?|specs?|e2e|playwright|fixtures|pages|page-objects|support|helpers)\/.*\.(?:[cm]?[jt]sx?)$/i,
      /(^|\/)playwright(?:-[^/]+)?\.config\.[cm]?[jt]sx?$/i,
      /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/i,
    ],
    exclude: [
      /(^|\/)(node_modules|dist|coverage|out|test-results|playwright-report|blob-report)\//,
      /\.d\.ts$/i,
    ],
  },
];

export function findAnalysisProfile(id: string): AnalysisProfile | undefined {
  return ANALYSIS_PROFILES.find(profile => profile.id === id);
}

export function isRelevantToProfile(profile: AnalysisProfile, filePath: string): boolean {
  return profile.include.some(pattern => pattern.test(filePath)) &&
    !profile.exclude.some(pattern => pattern.test(filePath));
}
