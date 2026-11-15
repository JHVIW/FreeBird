"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Ververst de pagina zolang hij getoond wordt, bijv. tijdens een achtergrondtaak. */
export function AutoRefresh({ every = 3000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [router, every]);
  return null;
}

/** Vinkt alle checkboxen met deze naam in dit formulier aan of uit. */
export function SelectAll({ form, name, label }: { form: string; name: string; label: string }) {
  return (
    <label className="check small">
      <input
        type="checkbox"
        onChange={(e) => {
          document.querySelectorAll<HTMLInputElement>(`input[name="${name}"][form="${form}"]`).forEach((el) => { el.checked = e.target.checked; });
        }}
      />
      {label}
    </label>
  );
}
