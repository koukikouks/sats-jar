import { Route, Routes } from "react-router";
import { AcceptTransfer } from "./screens/AcceptTransfer.tsx";
import { ChildSetUp } from "./screens/ChildSetUp.tsx";
import { DraftPage } from "./screens/DraftPage.tsx";
import { Home } from "./screens/Home.tsx";
import { JarPage } from "./screens/JarPage.tsx";
import { JoinPage } from "./screens/JoinPage.tsx";
import { NewJar } from "./screens/NewJar.tsx";
import { ProofPage } from "./screens/ProofPage.tsx";
import { Receive } from "./screens/Receive.tsx";
import { Restore } from "./screens/Restore.tsx";
import { Header } from "./ui/Header.tsx";

export function App() {
  return (
    <>
      <Header />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<NewJar />} />
          <Route path="/draft/:draftId" element={<DraftPage />} />
          <Route path="/join/:token" element={<JoinPage />} />
          <Route path="/jar/:jarId" element={<JarPage />} />
          <Route path="/jar/:jarId/set-up" element={<ChildSetUp />} />
          <Route path="/jar/:jarId/accept" element={<AcceptTransfer />} />
          <Route path="/restore" element={<Restore />} />
          <Route path="/receive" element={<Receive />} />
          <Route path="/proof/:jarId" element={<ProofPage />} />
        </Routes>
      </main>
    </>
  );
}
