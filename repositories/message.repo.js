import supabase from "../lib/supabase.js";

export async function insertMessage(payload) {
  const { data } = await supabase
    .from("messages")
    .insert(payload)
    .select()
    .single();

  return data;
}

export async function fetchMessages(chatId) {
  const { data } = await supabase
    .from("messages")
    .select("*")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });

  return data || [];
}
