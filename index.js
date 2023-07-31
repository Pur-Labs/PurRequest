const { default: axios } = require("axios");
const { execSync } = require("child_process");
const { mkdirSync, writeFileSync } = require("fs");
const { Octokit } = require("octokit");

let config = {
    githubToken: process.env.GITHUB_TOKEN,
    personalAccessToken: process.env.INPUT_PERSONAL_ACCESS_TOKEN,
    purgptApiKey: process.env.INPUT_PURGPT_API_KEY,
    issue: process.env.INPUT_ISSUE,
    repository: process.env.INPUT_REPOSITORY,
    model: process.env.INPUT_MODEL ?? 'gpt-3.5-turbo-16k'
};

const gitHub = new Octokit({
    auth: config.pat,
    request: {
        fetch: async (url, options) => {
            let response;

            try {
                response = await axios({
                    url,
                    method: options.method,
                    data: options.body,
                    headers: {
                        ...options.headers,
                        Authorization: `Bearer ${config.personalAccessToken}`
                    }
                });
            } catch (error) {
                console.error('Error occured while fetching from GitHub.', error, error?.response?.data);

                response = error;
            };

            return {
                status: response.status,
                json: () => Promise.resolve(response?.data ?? error.response ?? {}),
                headers: response.headers
            };
        }
    }
});

function code(content) {
    return /```(\w+)?\n([\s\S]*?)\n```/.exec(content)?.[2];
};

async function purgpt(message) {
    let response;
    let tries = 0;

    console.log('Asking', message);

    while (!response && tries < 3) {
        try {
            response = (await axios.post('https://beta.purgpt.xyz/openai/chat/completions', {
                model: config.model,
                messages: [
                    {
                        role: 'system',
                        content: `You are PurRequest, a GitHub bot that automatically manages pull requests. Your current task is create a pull request for issue #${config.issue.number}. Here is the issue description:\n\n**Number:** ${config.issue.number}\n**Title:** ${config.issue.title}\n**Author:** ${config.issue.user.login}\n**Labels:** ${config.issue.labels.map(label => label.name).join(', ')}\n**Message:** ${config.issue.body}\n\nCurrent file map of the repository:\n${config.files.map(file => file).join('\n')}\nYou can only respond with code blocks with JSON format. You have to provide the correct information to users.`
                    },
                    ...[message]
                ]
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${config.purgptApiKey}`
                }
            })).data;
        } catch (error) {
            console.error('Error occured while fetching from PurGPT.', error, error?.response?.data);
        };

        tries++;

        await new Promise(resolve => setTimeout(resolve, 3000));
    };

    if (!response) throw new Error('Failed to fetch from PurGPT.');

    console.log('Response', response);

    return response;
};

async function validJSON(message) {
    let response;
    let json;

    while (!json) {
        try {
            response = await purgpt(message);
            response = response.choices[0].content;

            if (code(response)) json = JSON.parse(code(response));
        } catch (error) {
            console.error('Error occured while checking JSON.', error, error?.response?.data);
        };
    };

    return json;
};

(async () => {
    config.user = (await gitHub.rest.users.getAuthenticated()).data;
    config.repository = (await gitHub.rest.repos.get({
        owner: config.repository.split('/')[0],
        repo: config.repository.split('/')[1]
    })).data;

    execSync(`git clone https://${config.personalAccessToken}@github.com/${config.repository.owner}/${config.repository.name} && cd ./${config.repository.name} && git config user.email "${config.user.email}" && git config user.name "${config.user.login}" && git checkout -b issue-${config.issue.number}`);

    config.files = execSync(`cd ${config.repository.name} && git ls-files`).toString().split('\n').filter(file => file);

    let createFiles = await validJSON({
        role: 'user',
        content: "Fill the following JSON with the files you want to create/edit. If you won't create any file, leave it an empty array.\n\n```json\n[\n{\n\"path\": \"example: path/to/file.js\",\n\"content\": \"file content\"\n}\n]\n```"
    });

    for (let createFile of createFiles) {
        let folders = createFile.path.split('/');

        folders.pop();

        let path = '';

        for (let folder of folders) {
            path += `/${folder}`;

            try {
                mkdirSync(`./${config.repository.name}${path}`);
            } catch (error) {
                console.error('Error occured while creating folder.', error);
            };
        };

        writeFileSync(`./${config.repository.name}/${createFile.path}`, createFile.content);
    };

    execSync(`cd ./${config.repository.name} && git add . && git commit -m "Issue ${config.issue.number}" && git push`);

    await gitHub.rest.pulls.create({
        owner: config.repository.owner,
        repo: config.repository.name,
        title: `Issue ${config.issue.number}`,
        head: `issue-${config.issue.number}`,
        base: config.repository.default_branch,
        body: `Fixes Issue #${config.issue.number}`
    });
})();