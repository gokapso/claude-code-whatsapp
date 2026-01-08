const GITHUB_API = "https://api.github.com";

export type GitHubRepo = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
};

export async function fetchAccessibleRepos(): Promise<GitHubRepo[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const repos: GitHubRepo[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetch(
      `${GITHUB_API}/user/repos?per_page=${perPage}&page=${page}&sort=updated`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    const data = (await response.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
      permissions?: { push?: boolean };
    }>;

    if (data.length === 0) break;

    // Only include repos where user has push access
    for (const repo of data) {
      if (repo.permissions?.push) {
        repos.push({
          fullName: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          private: repo.private,
        });
      }
    }

    if (data.length < perPage) break;
    page++;
  }

  return repos;
}
