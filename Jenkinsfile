pipeline {
    agent none

    stages {

        stage("Code") {
            agent { label "mylabel" }
            steps {
                echo "Initializing the code..."
                git url: "https://github.com/praveenkumar-co/reverse-proxy", branch: "main"
                echo "Repository cloned successfully."
            }
        }
        stage("Build") {
    agent { label "mylabel" }
    steps {
        echo "Installing dependencies..."
        sh "npm install"

        echo "Building TypeScript..."
        sh "npm run build"
    }
}
        stage("SonarQube Analysis") {
            agent { label "mylabel" }

            environment {
                scannerHome = tool 'SonarScanner'
            }

            steps {
                withSonarQubeEnv('SonarQube') {
                   sh "$scannerHome/bin/sonar-scanner"
                }
            }
        }

        stage("Trivy File System Scan") {
            agent { label "mylabel" }
            steps {
                sh "trivy fs ."
            }
        }

        stage("Test") {
            agent { label "mylabel" }
            steps {
                echo "Starting application..."
                sh '''
                timeout 10s npm start || [ $? -eq 124 ]
                '''
            }
        }
stage("Docker Build") {
    agent { label "mylabel2" }

    steps {
        git url: "https://github.com/praveenkumar-co/reverse-proxy", branch: "main"
        sh "docker build -t reverse-proxy ."
    }
}
        stage("Docker Image Scan") {
            agent { label "mylabel2" }
            steps {
                echo "Scanning Docker image..."
                sh "trivy image reverse-proxy"
            }
        }

        stage("Deploy") {
            agent { label "mylabel2" }
            steps {
                echo "Deploy stage completed."
            }
        }
    }
}