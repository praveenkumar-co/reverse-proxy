pipeline {
    agent any
    // agent none is also valid — in that case, each stage must declare its own agent

    options {
        timeout(time: 1, unit: 'HOURS')                 // aborts the pipeline if it runs longer than this
        buildDiscarder(logRotator(numToKeepStr: '10'))   // keeps only the last 10 builds, saving disk space
        disableConcurrentBuilds()                        // prevents overlapping runs of the same pipeline
        timestamps()                                      // timestamps every console log line
    }

    parameters {
        choice(name: 'ENV_TYPE', choices: ['dev', 'staging', 'prod'], description: 'Target Environment')
        booleanParam(name: 'RUN_TESTS', defaultValue: true, description: 'Run Unit Tests?')
    }

    environment {
        // Credentials use "=", not ":", inside the environment block
        API_KEY     = credentials('prod-api-key-id')
        APP_VERSION = "1.0.${BUILD_NUMBER}"
    }

    tools {
        nodejs 'nodeJS18'   // must match a tool name configured in Manage Jenkins → Tools
    }

    stages {
        stage('Setup') {
            steps {
                echo "Initializing build for ${params.ENV_TYPE} environment"
                sh 'npm ci'   // npm ci is faster and more deterministic than npm install — preferred in CI/production
            }
        }

        stage('Static Analysis') {
            parallel {
                stage('Lint') {
                    steps {
                        echo 'Linting source code'
                        sh 'npm run lint'
                    }
                }
                stage('Security Scan') {
                    steps {
                        echo 'Scanning dependencies for vulnerabilities'
                        sh 'npm audit'   // "npm audit" is a built-in command, not an npm script
                    }
                }
            }
        }

        stage('Unit Tests') {
            when {
                expression { return params.RUN_TESTS }
            }
            steps {
                sh 'npm test'
                junit 'test-results.xml'   // publishes test results in Jenkins UI
            }
            post {
                failure {
                    echo 'Unit tests failed — please check the logs'
                }
            }
        }

        stage('Build Artifact') {
            steps {
                sh 'npm run build'
            }
        }

        stage('Deploy to Production') {
            when {
                allOf {
                    branch 'main'
                    expression { params.ENV_TYPE == 'prod' }
                }
            }
            steps {
                input message: 'Deploy to Production?', ok: 'Yes, Deploy!'
                sh './scripts/deploy_prod.sh'
            }
        }
    }

    post {
        always {
            sh 'rm -rf ./temp-directories'
            cleanWs()   // cleans the workspace after every run, pass or fail
        }
        success {
            echo "Build Successful! Deployed version ${APP_VERSION}"
            // mail to: 'team@example.com', subject: 'Success'
        }
        failure {
            echo "Build Failed. Check logs."
            // slackSend channel: '#devops-alerts', message: "Build Failed: ${JOB_NAME}"
        }
    }
}
