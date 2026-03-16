"use client";

import { createContext, useContext, ReactNode, useState, useEffect } from "react";

export type UserRole = 'SOCIO' | 'ANALISTA';

interface UserContextType {
  role: UserRole;
  companyDomain: string;
  email: string;
  selectedCompany: string;
  setSelectedCompany: (company: string) => void;
}

const UserContext = createContext<UserContextType | undefined>(undefined);

export function useUser() {
  const context = useContext(UserContext);
  if (!context) {
    throw new Error('useUser must be used within a UserProvider');
  }
  return context;
}

interface UserProviderProps {
  children: ReactNode;
  email: string;
  role: UserRole;
}

export function UserProvider({ children, email, role }: UserProviderProps) {
  const [selectedCompany, setSelectedCompany] = useState<string>('');
  const [companyDomain, setCompanyDomain] = useState<string>('');

  useEffect(() => {
    const domain = email.split('@')[1] || '';
    setCompanyDomain(domain);
  }, [email]);

  const contextValue: UserContextType = {
    role,
    companyDomain,
    email,
    selectedCompany,
    setSelectedCompany,
  };

  return (
    <UserContext.Provider value={contextValue}>
      {children}
    </UserContext.Provider>
  );
}

/** Global layout wrapper — enforces black background and Helvetica Now Display typography */
export default function LayoutWrapper({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: '#000000',
        minHeight: '100vh',
        fontFamily:
          "'Helvetica Now Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
        fontWeight: 200,
        color: '#ffffff',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {children}
    </div>
  );
}
