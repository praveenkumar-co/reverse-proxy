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
        stage("Quality Gate") {
    agent none
    steps {
        timeout(time: 5, unit: 'MINUTES') {
            waitForQualityGate abortPipeline: true
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

        sh "docker build -t pravi2005/reverse-proxy:latest ."
    }
}
stage("Docker Push") {
    agent { label "mylabel2" }

    steps {
        withCredentials([usernamePassword(
            credentialsId: 'dockerhub',
            usernameVariable: 'DOCKER_USER',
            passwordVariable: 'DOCKER_PASS'
        )]) {

            sh '''
                echo "$DOCKER_PASS" | docker login -u "$DOCKER_USER" --password-stdin
                docker push pravi2005/reverse-proxy:latest
                docker logout
            '''
        }
    }
}
        stage("Docker Image Scan") {
            agent { label "mylabel2" }
            steps {
                echo "Scanning Docker image..."
               sh "trivy image pravi2005/reverse-proxy:latest"
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