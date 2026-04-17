import { createClient } from '@supabase/supabase-js';
import { getClerkInstance } from '@clerk/expo';

export const SUPABASE_URL = 'https://xutbbirehugrrbkauhnl.supabase.co';
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dGJiaXJlaHVncnJia2F1aG5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NTAsImV4cCI6MjA4ODA0NDk1MH0.OjNH1MR3rJcxMNLcIewgMZxU_iBJOGRfxewEu8LlxMU';

async function getClerkToken(): Promise<string | null> {
  try {
    const token = await getClerkInstance().session?.getToken();
    return token ?? null;
  } catch {
    return null;
  }
}

const clerkFetch: typeof fetch = async (input, init) => {
  const token = await getClerkToken();
  if (!token) return fetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: { fetch: clerkFetch },
});

export async function getUser(): Promise<{ id: string; created_at: string } | null> {
  const user = getClerkInstance().user;
  if (!user) return null;
  const createdAt =
    user.createdAt instanceof Date
      ? user.createdAt.toISOString()
      : new Date(user.createdAt ?? Date.now()).toISOString();
  return { id: user.id, created_at: createdAt };
}

export async function getSession(): Promise<{ access_token: string; user: { id: string } } | null> {
  const session = getClerkInstance().session;
  if (!session) return null;
  const token = await session.getToken();
  if (!token) return null;
  return { access_token: token, user: { id: session.user?.id ?? '' } };
}

export async function getUserId(): Promise<string | null> {
  return getClerkInstance().user?.id ?? null;
}

export async function deleteAccount(): Promise<void> {
  const userId = await getUserId();
  if (!userId) throw new Error('Not signed in');

  const token = await getClerkToken();
  if (!token) throw new Error('Not signed in');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('delete_account_timeout');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`delete_account_failed: ${response.status} ${body}`);
  }

  await getClerkInstance().signOut();
}
