uniform sampler2D u_Texture0; 
varying vec2 texture_coordinate;

void main()
{
	
    // Sampling The Texture And Passing It To The Frame Buffer 
    gl_FragColor = texture2D(u_Texture0, texture_coordinate); 
	gl_FragColor.r=(gl_FragColor.r+gl_FragColor.g+gl_FragColor.b)/3;
	gl_FragColor.b=gl_FragColor.r;
	gl_FragColor.g=gl_FragColor.r;

}	