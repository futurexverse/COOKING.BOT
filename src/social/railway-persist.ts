const RAILWAY_API = "https://api.railway.app/graphql/v2";

function getCredentials(): { token: string; projectId: string; environmentId: string } | null {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID;

  if (!token || !projectId || !environmentId) return null;
  return { token, projectId, environmentId };
}

async function graphqlFetch(query: string, token: string): Promise<any> {
  try {
    const resp = await fetch(RAILWAY_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(10000),
    });
    return await resp.json();
  } catch (err) {
    console.error("[Railway] API error:", err);
    return null;
  }
}

export async function getVariable(name: string): Promise<{ id: string; value: string } | null> {
  const creds = getCredentials();
  if (!creds) return null;

  const data = await graphqlFetch(`query {
    variables(input: {
      projectId: "${creds.projectId}",
      environmentId: "${creds.environmentId}"
    }) {
      edges {
        node {
          id
          name
          value
        }
      }
    }
  }`, creds.token);

  const variables = data?.data?.variables?.edges || [];
  for (const edge of variables) {
    if (edge.node.name === name) {
      return { id: edge.node.id, value: edge.node.value };
    }
  }
  return null;
}

export async function setVariable(name: string, value: string): Promise<boolean> {
  const creds = getCredentials();
  if (!creds) return false;

  const existing = await getVariable(name);

  if (existing) {
    const data = await graphqlFetch(`mutation {
      variableUpdate(input: {
        id: "${existing.id}"
        value: "${value.replace(/"/g, '\\"')}"
      }) {
        id
        value
      }
    }`, creds.token);

    if (data?.errors) {
      console.error("[Railway] Failed to update variable:", data.errors);
      return false;
    }
    console.log(`[Railway] Updated ${name} (id: ${existing.id})`);
    return true;
  } else {
    const data = await graphqlFetch(`mutation {
      variableCreate(input: {
        projectId: "${creds.projectId}"
        environmentId: "${creds.environmentId}"
        name: "${name}"
        value: "${value.replace(/"/g, '\\"')}"
      }) {
        id
        value
      }
    }`, creds.token);

    if (data?.errors) {
      console.error("[Railway] Failed to create variable:", data.errors);
      return false;
    }
    console.log(`[Railway] Created ${name}`);
    return true;
  }
}

export async function appendToVariable(name: string, suffix: string): Promise<void> {
  const creds = getCredentials();
  if (!creds) return;

  const existing = await getVariable(name);
  const currentValue = existing?.value || "";
  const parts = currentValue.split(",").map(s => s.trim()).filter(Boolean);

  if (!parts.includes(suffix)) {
    parts.push(suffix);
    const newValue = parts.join(",");
    process.env[name] = newValue;
    await setVariable(name, newValue);
  }
}

export function isRailwayPersistAvailable(): boolean {
  return getCredentials() !== null;
}
