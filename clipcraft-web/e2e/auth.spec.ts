import { expect, test } from '@playwright/test';
import { mockAuthApi } from './support/flows';

test('landing to login to workspace flow works', async ({ page }) => {
  await mockAuthApi(page, { signedIn: false });
  await page.goto('/');

  await expect(page.getByAltText('ClipCraft').first()).toBeVisible();
  // 로그인하지 않았으면 편집을 시작하는 버튼은 없고 로그인 버튼만 보인다.
  await expect(page.getByRole('button', { name: '지금 시작하기' })).toHaveCount(0);

  await page.getByTestId('login-link').click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByTestId('email-input').fill('qa@example.com');
  await page.getByTestId('password-input').fill('Password123');
  await page.getByTestId('login-submit-button').click();

  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', { name: '내 프로젝트' })).toBeVisible();
});

test('wrong password shows an error and stays on login', async ({ page }) => {
  await mockAuthApi(page, { signedIn: false });
  await page.goto('/login');

  await page.getByTestId('email-input').fill('qa@example.com');
  await page.getByTestId('password-input').fill('wrong');
  await page.getByTestId('login-submit-button').click();

  await expect(page.getByText('이메일 또는 비밀번호가 올바르지 않습니다')).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test('private pages send signed-out visitors to the login screen', async ({ page }) => {
  await mockAuthApi(page, { signedIn: false });
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/auth|\/login/);
});
