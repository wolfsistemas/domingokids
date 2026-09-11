// config.js - Configuração central do Supabase
const SUPABASE_URL = 'https://asriklhdbzxubdcuauoz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFzcmlrbGhkYnp4dWJkY3VhdW96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTkzNzcsImV4cCI6MjEwMDgzNTM3N30.vhOVWm--45F7CTthWG4pZJdqo4DDcG6vMnua1hYSUuM';

// Para compatibilidade com os nomes usados nos HTMLs
const SB_URL = SUPABASE_URL;
const SB_KEY = SUPABASE_ANON_KEY;
const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1';
const VAPID_PUBLIC_KEY = 'BJ4YbI1bdeeM_GzNCpS-nq1lA1eeGEdahIn09pmL4qchZ92AIsURlLzoj6cPr57IruFBoZ8mD-6dSrtsKeU5NFQ';

// Instância global do cliente Supabase (será usada em todos os lugares)
//const supabaseClient = supabase.createClient(SB_URL, SB_KEY);

// Upload de imagens: usa a Edge Function `imgbb-upload` (chave mantida no servidor).

