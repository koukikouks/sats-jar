import { createProofReader } from "@sats-jar/proof";
import { browserStorage, createSatsJar } from "@sats-jar/sdk";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.tsx";
import { config } from "./config.ts";
import { Services } from "./services.tsx";
import "./theme.css";
import "./app.css";

const sdk = createSatsJar({ contract: config.contract, backendUrl: config.backendUrl, storage: browserStorage() });
const proof = createProofReader({ contract: config.contract });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Services sdk={sdk} proof={proof}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Services>
  </StrictMode>,
);
