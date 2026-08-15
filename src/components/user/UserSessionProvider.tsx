"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { useUser } from "@/lib/hooks/useUser";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { UserProfile } from "@/lib/types";

type UserSessionContextValue = {
  user: User | null | undefined;
  profile: UserProfile | null | undefined;
  profileLoading: boolean;
  refreshProfile: () => Promise<void>;
  setProfile: (profile: UserProfile | null | undefined) => void;
};

const UserSessionContext = createContext<UserSessionContextValue | null>(null);

export function UserSessionProvider({ children }: { children: React.ReactNode }) {
  const user = useUser();
  const [profile, setProfileState] = useState<UserProfile | null | undefined>(undefined);
  const [profileLoading, setProfileLoading] = useState(false);

  const refreshProfile = useCallback(async () => {
    const supabase = createSupabaseBrowserClient();
    if (!supabase) {
      setProfileState(null);
      setProfileLoading(false);
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) {
      setProfileState(null);
      setProfileLoading(false);
      return;
    }

    try {
      const response = await fetch("/api/user/profile", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setProfileState(null);
        return;
      }

      const data = (await response.json()) as { profile?: UserProfile | null };
      setProfileState(data.profile ?? null);
    } catch {
      setProfileState(null);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  const setProfile = useCallback((next: UserProfile | null | undefined) => {
    setProfileState(next);
  }, []);

  useEffect(() => {
    if (user === undefined) {
      setProfileState(undefined);
      setProfileLoading(false);
      return;
    }

    if (user === null) {
      setProfileState(null);
      setProfileLoading(false);
      return;
    }

    setProfileLoading(true);
    void refreshProfile();
  }, [user, refreshProfile]);

  const value = useMemo(
    () => ({
      user,
      profile,
      profileLoading,
      refreshProfile,
      setProfile,
    }),
    [user, profile, profileLoading, refreshProfile, setProfile],
  );

  return <UserSessionContext.Provider value={value}>{children}</UserSessionContext.Provider>;
}

export function useUserSession() {
  const context = useContext(UserSessionContext);
  if (!context) {
    throw new Error("useUserSession must be used inside UserSessionProvider");
  }
  return context;
}
