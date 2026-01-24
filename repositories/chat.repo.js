import supabase from "../lib/supabase.js";

export async function getOrCreateChat({ userId, chatId, initialTitle }) {
    if (chatId) {
        const { data: existing } = await supabase
            .from("chats")
            .select("*")
            .eq("id", chatId)
            .single();
        if (existing) return existing;
    }

    const { data } = await supabase
        .from("chats")
        .insert({
            user_id: userId,
            title: initialTitle || "New Chat",
        })
        .select()
        .single();

    return data;
}
