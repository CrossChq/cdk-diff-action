import { github, typescript } from 'projen';
import { Transform, UpgradeDependenciesSchedule } from 'projen/lib/javascript';
import { JsonPatch } from 'projen/lib/json-patch';
import { GitHubActionTypeScriptProject, RunsUsing } from 'projen-github-action-typescript';
const project = new GitHubActionTypeScriptProject({
  majorVersion: 1,
  defaultReleaseBranch: 'main',
  authorEmail: '43035978+corymhall@users.noreply.github.com',
  authorName: 'Cory Hall',
  name: 'cdk-diff-action',
  projenrcTs: true,
  depsUpgradeOptions: {
    workflowOptions: {
      labels: ['auto-approve'],
      schedule: UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  autoApproveOptions: {
    label: 'auto-approve',
    allowedUsernames: ['corymhall'],
  },
  actionMetadata: {
    author: 'Cory Hall',
    branding: {
      color: 'orange',
      icon: 'message-square',
    },
    description:
      'The CDK Diff GitHub Action allows you to run CDK diff as part of your CI/CD workflow.',
    name: 'cdk-diff-action',
    inputs: {
      githubToken: {
        description: 'github token',
        required: true,
      },
      allowedDestroyTypes: {
        description: 'Comma delimited list of resource types that are allowed to be destroyed',
        required: false,
        default: '',
      },
      failOnDestructiveChanges: {
        description: 'Whether or not destructive changes should fail the job',
        required: false,
        default: 'true',
      },
      noDiffForStages: {
        description: 'List of stages to ignore and not show a diff for',
        required: false,
        default: '',
      },
      noFailOnDestructiveChanges: {
        description: '',
        required: false,
        default: 'List of stages where breaking changes will not fail the build',
      },
    },
    runs: {
      using: RunsUsing.NODE_16, // overwrite to node20
      main: 'dist/index.js',
    },
  },
  deps: [
    '@octokit/webhooks-definitions',
    '@aws-cdk/cloudformation-diff',
    '@aws-cdk/cloud-assembly-schema',
    '@actions/exec@^1.1.1',
    '@actions/io@^1.1.3',
    '@actions/tool-cache@^2.0.0',
    'fs-extra',
    '@aws-sdk/client-cloudformation',
    '@smithy/types',
    'chalk@^4',
    '@aws-sdk/credential-providers',
  ],
  devDeps: [
    'mock-fs@^5',
    'aws-sdk-client-mock',
    '@types/mock-fs@^4',
    'projen-github-action-typescript',
    '@types/fs-extra',
    'action-docs',
    '@swc/core',
    '@swc/jest',
  ],
  jestOptions: {
    configFilePath: 'jest.config.json',
  },
  minNodeVersion: '18.12.0',
});


const projenProject = project as unknown as typescript.TypeScriptProject;
const jestConfig = projenProject.tryFindObjectFile('jest.config.json');
jestConfig?.patch(JsonPatch.remove('/preset'));
jestConfig?.patch(JsonPatch.remove('/globals'));
jestConfig?.patch(JsonPatch.add('/transform', {
  '^.+\\.(t|j)sx?$': new Transform('@swc/jest'),
}));
const actionYml = project.tryFindObjectFile('action.yml');
actionYml?.addOverride('runs.using', 'node20');
project.tasks.addTask('gh-release', {
  exec: 'ts-node projenrc/release-version.ts',
});

// setup merge queue
const buildWorkflow = project.github?.tryFindWorkflow('build');
buildWorkflow?.on({
  mergeGroup: {
    branches: ['main'],
  },
});
buildWorkflow?.file?.patch(JsonPatch.replace(
  '/jobs/build/steps/4/run', [
    'git add .',
    'git diff --staged --patch --binary --exit-code > .repo.patch || echo "self_mutation_happened=true" >> $GITHUB_OUTPUT',
  ].join('\n'),
));

project.tasks.tryFind('release')?.spawn(project.addTask('copy-files', {
  exec: 'cp package.json dist/ && cp -r projenrc dist/ && cp -r .git dist/',
}));

project.github?.tryFindWorkflow('release')?.file?.patch(JsonPatch.replace(
  '/jobs/release_github/steps/3/run',
  [
    'mv dist/package.json ./',
    'mv dist/projenrc ./',
    'mv dist/.git ./',
    'yarn install',
    'npx ts-node projenrc/release-version.ts',
  ].join('\n'),
));

project.gitignore.exclude('dist/package.json');
project.gitignore.exclude('dist/projenrc');

const autoMergeJob: github.workflows.Job = {
  name: 'Set AutoMerge on PR #${{ github.event.number }}',
  runsOn: ['ubuntu-latest'],
  permissions: {
    pullRequests: github.workflows.JobPermission.WRITE,
    contents: github.workflows.JobPermission.WRITE,
  },
  steps: [
    {
      uses: 'peter-evans/enable-pull-request-automerge@v2',
      with: {
        'token': '${{ secrets.GITHUB_TOKEN }}',
        'pull-request-number': '${{ github.event.number }}',
        'merge-method': 'SQUASH',
      },
    },
  ],
};

projenProject.github?.tryFindWorkflow('auto-approve')?.file?.patch(JsonPatch.replace('/jobs/approve/steps/0/uses', 'hmarr/auto-approve-action@v3'));

const workflow = projenProject.github?.addWorkflow('auto-merge');
workflow?.on({
  // The 'pull request' event gives the workflow 'read-only' permissions on some
  // pull requests (such as the ones from dependabot) when using the `GITHUB_TOKEN`
  // security token. This prevents the workflow from approving these pull requests.
  // Github has placed this guard so as to prevent security attacks by simply opening
  // a pull request and triggering a workflow on a commit that was not vetted to make
  // unintended changes to the repository.
  //
  // Instead use the 'pull request target' event here that gives the Github workflow
  // 'read-write' permissions. This is safe because, this event, unlike the 'pull request'
  // event references the BASE commit of the pull request and not the HEAD commit.
  //
  // We only enable auto-merge when a PR is opened, reopened or moving from Draft to Ready.
  // That way a user can always disable auto-merge if they want to and the workflow will
  // not automatically re-enable it, unless one of the events occurs.
  pullRequestTarget: {
    types: ['opened', 'reopened', 'ready_for_review'],
  },
});

projenProject.packageTask.reset();
projenProject.packageTask.exec('cp node_modules/@aws-cdk/aws-service-spec/db.json.gz ./ && ncc build --source-map --license licenses.txt');
workflow?.addJobs({ enableAutoMerge: autoMergeJob });
project.synth();
