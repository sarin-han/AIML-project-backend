import { expect, type Page, type Route } from '@playwright/test';
import path from 'node:path';

export const projectName = '김치찌개 브이로그 쇼츠';
export const scenarios = ['재료를 손질하는 장면', '김치찌개가 끓는 장면', '완성된 음식을 담는 장면'];
export const sampleVideoPath = path.join(process.cwd(), 'e2e/fixtures/sample.mp4');


const qaUser = { id: 'u1', name: 'QA', email: 'qa@example.com', marketing_consent: false, created_at: '2026-01-01T00:00:00' };
const authedPages = new WeakSet<Page>();

function v1(data: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify({ data, meta: { request_id: 'req_test' } }) };
}

function v1Error(status: number, code: string, message: string) {
  return { status, contentType: 'application/json', body: JSON.stringify({ error: { code, message, details: [] }, meta: { request_id: 'req_test' } }) };
}

/**
 * 인증·프로젝트 API(/api/v1)를 메모리로 대신한다. signedIn이면 이미 로그인한 상태로 시작한다.
 * 비밀번호가 'wrong'이면 로그인이 거절된다.
 */
export async function mockAuthApi(page: Page, { signedIn = true }: { signedIn?: boolean } = {}) {
  if (authedPages.has(page)) return;
  authedPages.add(page);

  const tokens = { user: qaUser, access_token: 'test-access', token_type: 'bearer', expires_in: 900, refresh_token: 'test-refresh', refresh_expires_in: 2592000 };
  const projects: Array<Record<string, unknown>> = [];
  let nextId = 1;
  const now = () => new Date().toISOString();

  if (signedIn) {
    await page.addInitScript(() => {
      window.localStorage.setItem('auth-access-token', 'test-access');
      window.localStorage.setItem('auth-refresh-token', 'test-refresh');
    });
  }

  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const parts = url.pathname.replace(/^.*\/api\/v1\//, '').split('/');

    if (parts[0] === 'auth') {
      const body = request.postDataJSON() as { password?: string } | null;
      if (parts[1] === 'login' && body?.password === 'wrong') return route.fulfill(v1Error(401, 'INVALID_CREDENTIALS', '이메일 또는 비밀번호가 올바르지 않습니다.'));
      if (parts[1] === 'logout') return route.fulfill({ status: 204 });
      return route.fulfill(v1(tokens, parts[1] === 'signup' ? 201 : 200));
    }
    if (parts[0] === 'users') return route.fulfill(v1(qaUser));

    if (parts[0] === 'projects') {
      const id = parts[1];
      const project = projects.find((item) => item.id === id);
      if (!id) {
        if (method === 'POST') {
          const input = request.postDataJSON() as { title: string; format: string };
          const created = { id: `p${nextId++}`, title: input.title, status: 'draft', format: input.format, source_duration_seconds: null, exported_duration_seconds: null, scene_count: 0, source_size_bytes: null, starred: false, preview_url: null, analysis_progress: null, version: 1, created_at: now(), updated_at: now() };
          projects.unshift(created);
          return route.fulfill(v1(created, 201));
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: projects, meta: { request_id: 'req_test', page: 1, page_size: 50, total: projects.length, total_pages: 1 } }) });
      }
      if (!project) return route.fulfill(v1Error(404, 'RESOURCE_NOT_FOUND', '프로젝트를 찾을 수 없습니다.'));
      if (method === 'PATCH') {
        Object.assign(project, request.postDataJSON(), { updated_at: now() });
        project.version = Number(project.version) + 1;
        return route.fulfill(v1(project));
      }
      if (method === 'DELETE') {
        projects.splice(projects.indexOf(project), 1);
        return route.fulfill({ status: 204 });
      }
    }
    return route.fulfill(v1Error(404, 'RESOURCE_NOT_FOUND', 'not mocked'));
  });
}

export async function login(page: Page) {
  await mockAuthApi(page, { signedIn: false });
  await page.goto('/login');
  await page.getByTestId('email-input').fill('qa@example.com');
  await page.getByTestId('password-input').fill('Password123');
  await page.getByTestId('login-submit-button').click();
  await expect(page).toHaveURL(/\/workspace$/);
}

export async function createProject(page: Page, name = projectName) {
  await mockAuthApi(page);
  await page.goto('/workspace');
  await page.getByTestId('new-project-button').click();
  await page.getByTestId('project-name-input').fill(name);
  await expect(page.getByTestId('aspect-ratio-select').first()).toContainText('세로 9:16');
  await page.getByTestId('start-editing-button').click();
  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByTestId('project-title')).toHaveText(name);
  await expect(page.getByTestId('project-aspect-ratio')).toHaveText('세로 9:16');
}

export async function uploadSampleVideo(page: Page) {
  await expect(page.getByTestId('video-upload-area')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(sampleVideoPath);
  await expect(page.getByText('sample.mp4')).toBeVisible();
}

export async function addScenarios(page: Page) {
  const input = page.getByTestId('scenario-input');
  for (const [index, scenario] of scenarios.entries()) {
    await input.fill(scenario);
    await page.getByTestId('add-scenario-button').click();
    // 장면은 바로 고칠 수 있는 입력칸으로 보여 주므로 글자가 아니라 입력 값으로 확인한다.
    await expect(page.getByTestId('scenario-item-input').nth(index)).toHaveValue(scenario);
  }
}

export async function mockAnalysisApi(page: Page) {
  // 채팅 편집 서버(LLM)에는 닿지 않게 막는다. 화면은 예전의 정해진 명령 처리로 대신한다. 필요한 테스트는 이 경로를 다시 mock한다.
  await page.route('**/chat/edit', (route: Route) => route.abort());

  await page.route('**/analyze/jobs', async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'success', job_id: 'mock-job' }),
    });
  });

  await page.route('**/analyze/jobs/mock-job', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        progress: 100,
        step_id: 5,
        step_label: '하이라이트 구간 확정',
        message: 'mock analysis complete',
        logs: ['mock: received video', 'mock: matched 3 scenarios'],
        project: projectName,
        results: scenarios.map((scenario, index) => ({
          project_name: projectName,
          id: index + 1,
          scenario,
          title: scenario,
          start: 12 + index * 20,
          end: 20 + index * 20,
          score: Number((0.94 - index * 0.04).toFixed(2)),
          audio: {
            duration: 90,
            barCount: 88,
            amplitudes: Array.from({ length: 88 }, (_, barIndex) => Number((0.25 + Math.abs(Math.sin(barIndex * 0.35)) * 0.7).toFixed(3))),
          },
        })),
        error: null,
      }),
    });
  });
}

export async function runAnalysisFlow(page: Page) {
  await mockAnalysisApi(page);
  await createProject(page);
  await uploadSampleVideo(page);
  await addScenarios(page);
  await page.getByTestId('analyze-start-button').click();
  await expect(page.getByTestId('loading-page')).toBeVisible();
  await expect(page).toHaveURL(/\/editor\/mock-job$/);
  await expect(page.getByTestId('result-card')).toHaveCount(3);
}
