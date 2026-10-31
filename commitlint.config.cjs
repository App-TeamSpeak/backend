module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'test', 'refactor', 'perf', 'style', 'build', 'ci', 'chore', 'revert',
    ]],
  },
  helpUrl: 'https://www.conventionalcommits.org/es/v1.0.0/',
};
