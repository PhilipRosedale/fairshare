async function loadProfile() {
    const { data, error } = await db
        .from('profiles')
        .select('*')
        .eq('id', currentUser.id)
        .single();
    if (data) currentProfile = data;
    // phone/email live in profile_private (self-only RLS) — not on profiles
    if (currentProfile && currentUser?.id) {
        const { data: priv } = await db
            .from('profile_private')
            .select('phone, email')
            .eq('user_id', currentUser.id)
            .maybeSingle();
        currentProfile.phone = priv?.phone ?? null;
        currentProfile.email = priv?.email ?? null;
    }
}
