import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://xutbbirehugrrbkauhnl.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh1dGJiaXJlaHVncnJia2F1aG5sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NTAsImV4cCI6MjA4ODA0NDk1MH0.OjNH1MR3rJcxMNLcIewgMZxU_iBJOGRfxewEu8LlxMU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
}

export async function getUserId(): Promise<string | null> {
  const user = await getUser();
  return user?.id ?? null;
}

export async function deleteAccount(): Promise<void> {
  const userId = await getUserId();
  if (!userId) throw new Error('Not signed in');

  const { error: swingsError } = await supabase
    .from('swings')
    .delete()
    .eq('user_id', userId);
  if (swingsError) throw swingsError;

  const { error: profileError } = await supabase
    .from('profiles')
    .delete()
    .eq('id', userId);
  if (profileError) throw profileError;

  await supabase.auth.signOut();
}
