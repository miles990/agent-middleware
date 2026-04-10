/**
 * Plan Templates — reusable DAG structures with parametric instantiation.
 *
 * Templates let agents create plans with one API call:
 *   POST /plan/from-template { template: "codebase-analysis", params: { target: "/path/to/repo" } }
 *
 * Parameters use {{param}} syntax — replaced at instantiation time.
 */

import type { ActionPlan } from './plan-engine.js';

export interface PlanTemplate {
  name: string;
  description: string;
  params: Array<{ name: string; description: string; required: boolean }>;
  plan: ActionPlan;
}

export const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    name: 'codebase-analysis',
    description: 'Analyze a codebase: scan structure, check quality, produce improvement report',
    params: [
      { name: 'target', description: 'Path to the codebase root', required: true },
      { name: 'focus', description: 'Analysis focus (e.g. "architecture", "security", "performance")', required: false },
    ],
    plan: {
      goal: 'Analyze {{target}} codebase and produce improvement report',
      acceptance: 'Report covers structure, quality issues, and actionable recommendations',
      steps: [
        { id: 'scan-structure', worker: 'shell', label: '掃描檔案結構',
          task: 'find {{target}}/src -name "*.ts" -o -name "*.js" -o -name "*.py" | wc -l && echo "files" && wc -l {{target}}/src/*.ts 2>/dev/null | sort -rn | head -10',
          dependsOn: [] },
        { id: 'check-deps', worker: 'shell', label: '檢查依賴',
          task: 'cat {{target}}/package.json 2>/dev/null | head -30 || cat {{target}}/requirements.txt 2>/dev/null | head -20 || echo "no deps file"',
          dependsOn: [] },
        { id: 'find-issues', worker: 'shell', label: '搜尋 TODO/FIXME',
          task: 'grep -rn "TODO\\|FIXME\\|HACK\\|XXX" {{target}}/src/ 2>/dev/null | head -20 || echo "none found"',
          dependsOn: [] },
        { id: 'analyze', worker: 'analyst', label: '分析品質',
          task: 'Analyze this codebase. Focus: {{focus}}. Structure: {{scan-structure.result}}. Dependencies: {{check-deps.result}}. Issues: {{find-issues.result}}. Return JSON: { "summary": "...", "findings": [...], "confidence": 0.8 }',
          dependsOn: ['scan-structure', 'check-deps', 'find-issues'] },
        { id: 'report', worker: 'analyst', label: '產出改善報告',
          task: 'Write improvement report. Goal: analyze {{target}}. Analysis: {{analyze.summary}}. Findings: {{analyze.findings}}. Return JSON: { "accepted": true, "summary": "...", "findings": [...], "recommendations": [...], "deliverable": "full report" }',
          dependsOn: ['analyze'] },
      ],
    },
  },
  {
    name: 'research-report',
    description: 'Research a topic from multiple sources and produce a structured report',
    params: [
      { name: 'topic', description: 'Research topic', required: true },
      { name: 'depth', description: '"quick" (3 sources) or "thorough" (5+ sources)', required: false },
    ],
    plan: {
      goal: 'Research "{{topic}}" and produce a comprehensive report',
      acceptance: 'Report covers multiple perspectives with cited sources',
      steps: [
        { id: 'search-web', worker: 'researcher', label: '網路搜尋',
          task: 'Search the web for "{{topic}}". Find at least 3 authoritative sources. Summarize key findings.',
          dependsOn: [], retry: { maxRetries: 2, backoffMs: 2000, onExhausted: 'skip' as const } },
        { id: 'search-code', worker: 'shell', label: '搜尋相關 code',
          task: 'grep -rn "{{topic}}" /Users/user/Workspace/ --include="*.md" --include="*.ts" 2>/dev/null | head -15 || echo "no local matches"',
          dependsOn: [] },
        { id: 'synthesize', worker: 'analyst', label: '綜合分析',
          task: 'Synthesize findings on "{{topic}}". Web: {{search-web.summary}}. Local: {{search-code.result}}. Return JSON: { "summary": "...", "findings": [...], "confidence": 0.8 }',
          dependsOn: ['search-web', 'search-code'] },
        { id: 'report', worker: 'analyst', label: '撰寫報告',
          task: 'Write a research report on "{{topic}}". Analysis: {{synthesize.summary}}. Return JSON: { "accepted": true, "summary": "...", "deliverable": "full report with sources" }',
          dependsOn: ['synthesize'] },
      ],
    },
  },
  {
    name: 'deploy-verify',
    description: 'Build, test, deploy, and verify a service',
    params: [
      { name: 'project', description: 'Project directory path', required: true },
      { name: 'service', description: 'Service name or URL to verify', required: true },
    ],
    plan: {
      goal: 'Build, test, and deploy {{project}}, verify {{service}} is healthy',
      acceptance: 'All tests pass and health check returns 200',
      steps: [
        { id: 'build', worker: 'shell', label: 'Build',
          task: 'cd {{project}} && npm run build 2>&1 | tail -5', dependsOn: [] },
        { id: 'test', worker: 'shell', label: 'Run tests',
          task: 'cd {{project}} && npm test 2>&1 | tail -20', dependsOn: ['build'] },
        { id: 'deploy', worker: 'shell', label: 'Deploy',
          task: 'cd {{project}} && npm run deploy 2>&1 || echo "deploy script not found"', dependsOn: ['test'],
          verifyCommand: 'curl -sf {{service}}/health' },
        { id: 'verify', worker: 'shell', label: 'Health check',
          task: 'curl -sf {{service}}/health && echo "HEALTHY" || echo "UNHEALTHY"', dependsOn: ['deploy'] },
      ],
    },
  },
];
